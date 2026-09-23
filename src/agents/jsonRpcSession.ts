import { Data, Effect, ExecutionStrategy, Exit, Option, Scope, type Context } from 'effect';
import { resumeFailedMessage } from './adapter';
import { AGENT_NAMES, type AgentErrorCode, type ContentBlock } from './events';
import { JsonRpcConnection, type ConnectionClosed, type MalformedMessage, type RpcError } from './jsonRpc';
import type { AgentSession } from './session';
import type { Stdio } from './stdio';
import type { WireMessage } from './traffic';
import type { Turn } from './turn';

/** How Uni Agent introduces itself to agents that ask. */
export const CLIENT_INFO = { name: 'uni-agent', title: 'Uni Agent', version: '0.0.1' };

/** A failure the agent reported that ends the turn, shown in the thread as an `error` event. */
export class AgentFailure extends Data.TaggedError('AgentFailure')<{ readonly code: AgentErrorCode; readonly message: string }> {}

/** What can go wrong talking to the agent during a turn. */
export type TurnError = AgentFailure | RpcError | ConnectionClosed;

/** A native session the agent has opened or resumed, and what it runs with. */
export interface OpenedSession {
  readonly sessionId: string;
  readonly model: string;
  readonly permissionMode: string;
}

/**
 * What an agent that runs as a JSON-RPC server brings to its connection: how to open a session and
 * send a prompt, and how to handle what the agent sends.
 */
export interface JsonRpcProtocol<T extends Turn> {
  /** The arguments that start the CLI's JSON-RPC server. */
  readonly args: ReadonlyArray<string>;
  /**
   * Initialises a new process and opens a session, resuming `resume` if given. A session that
   * cannot be resumed fails with {@link JsonRpcSession.resumeFailed}, never by opening another.
   */
  openSession(rpc: JsonRpcConnection, resume: Option.Option<string>): Effect.Effect<OpenedSession, TurnError>;
  /** Sends the prompt. The turn ends when the agent says so, through `AgentSession.endTurn`. */
  sendPrompt(rpc: JsonRpcConnection, sessionId: string, turn: T, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void, TurnError>;
  handleNotification(method: string, params: WireMessage | undefined): Effect.Effect<void, MalformedMessage>;
  /**
   * Answers a request from the agent; one it does not know is answered "method not found". The
   * answer itself is an effect run on a fiber of the connection's, so a request the user has to
   * answer does not hold up the agent's other messages.
   */
  handleRequest?(method: string, params: WireMessage | undefined): Effect.Effect<Option.Option<Effect.Effect<WireMessage>>, MalformedMessage>;
  /** How an error the agent answered a request with is shown; undefined (or left out) shows it as the agent's own error. */
  rpcFailure?(error: RpcError): AgentFailure | undefined;
}

interface Connection {
  readonly rpc: JsonRpcConnection;
  /** Holds the process and the reader; closing it kills the process. */
  readonly scope: Scope.CloseableScope;
}

/**
 * The connection to an agent that runs as a JSON-RPC server over stdio (Codex's app-server,
 * Cursor's ACP server), for its handler to use. The agent assigns the session ID, so the session is
 * announced once the first turn has created it.
 *
 * The process starts with the first prompt and serves every turn after it. If it dies, the running
 * turn ends as `error` and the next prompt starts a new process that resumes the session. A stored
 * session (`options.resume`) is resumed the same way by the first prompt. A session the agent
 * cannot resume ends the turn with `resume_failed`; a new one is never started in its place. The
 * process lives in a scope forked from the session's, so closing the session's scope stops it.
 */
export class JsonRpcSession<T extends Turn> {
  /** The native session, once the agent has created it. It is resumed after a crash. */
  private current: string | undefined;
  private connection: Connection | undefined;

  constructor(
    private readonly session: AgentSession<T>,
    private readonly stdio: Context.Tag.Service<Stdio>,
    private readonly protocol: JsonRpcProtocol<T>
  ) {
    this.current = session.options.resume;
  }

  /** The native session ID, once the agent has opened the session. */
  get sessionId(): string | undefined {
    return this.current;
  }

  /** Connects if need be, then sends the prompt; a failure ends the turn with what went wrong. */
  runTurn(turn: T, executable: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void> {
    return this.connect(executable).pipe(
      // A cancel that arrived while the session was opening had nothing to interrupt yet.
      Effect.flatMap(([rpc, sessionId]) => (turn.cancelRequested ? this.session.endTurn(turn, 'cancelled') : this.protocol.sendPrompt(rpc, sessionId, turn, prompt))),
      Effect.catchAll((error) => this.turnFailed(turn, error))
    );
  }

  /** Runs `f` against the open session, if there is one. */
  withSession<E>(f: (rpc: JsonRpcConnection, sessionId: string) => Effect.Effect<void, E>): Effect.Effect<void, E> {
    return Effect.suspend(() => {
      const { connection, current } = this;
      return connection && current !== undefined ? f(connection.rpc, current) : Effect.void;
    });
  }

  /** Stops the process, if one is running, without reporting it. */
  stop(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const connection = this.connection;
      this.connection = undefined;
      return connection ? Scope.close(connection.scope, Exit.void) : Effect.void;
    });
  }

  /** The failure that ends a turn whose session the agent could not resume; the thread becomes read-only. */
  resumeFailed(detail: string): AgentFailure {
    return new AgentFailure({ code: 'resume_failed', message: resumeFailedMessage(this.session.agent, detail) });
  }

  /** Reports an error answer to a resume request as a failed resume; other failures pass through. */
  resuming<A>(request: Effect.Effect<A, TurnError>): Effect.Effect<A, TurnError> {
    return Effect.mapError(request, (error) => (error._tag === 'RpcError' ? this.resumeFailed(error.message) : error));
  }

  /** Starts the agent if it is not running. If it cannot open the session, the process is stopped. */
  private connect(executable: string): Effect.Effect<readonly [JsonRpcConnection, string], TurnError> {
    return Effect.gen(this, function* () {
      if (this.connection && this.current !== undefined) {
        return [this.connection.rpc, this.current] as const;
      }
      const scope = yield* Scope.fork(this.session.scope, ExecutionStrategy.sequential);
      const process = yield* this.stdio.spawn({ executable, args: this.protocol.args, cwd: this.session.options.cwd }).pipe(Scope.extend(scope));
      const rpc = yield* JsonRpcConnection.open(process, {
        notification: (method, params) => Effect.suspend(() => this.protocol.handleNotification(method, params)),
        request: (method, params) => Effect.suspend(() => this.protocol.handleRequest?.(method, params) ?? Effect.succeedNone),
      }).pipe(Scope.extend(scope));
      const connection: Connection = { rpc, scope };
      this.connection = connection;
      yield* Effect.forkIn(Effect.flatMap(rpc.awaitClosed(), (reason) => this.closed(connection, reason)), this.session.scope);
      yield* Effect.logDebug(`Started ${AGENT_NAMES[this.session.agent]} (${executable} ${this.protocol.args.join(' ')}) in ${this.session.options.cwd}`);

      const { sessionId, model, permissionMode } = yield* this.protocol.openSession(rpc, Option.fromNullable(this.current)).pipe(
        // A closed connection is reported as a crash once its watcher sees it.
        Effect.tapError((error) => (error._tag === 'ConnectionClosed' ? Effect.void : this.stop()))
      );
      if (sessionId !== this.current) {
        this.current = sessionId;
        yield* this.session.emit({ type: 'session_started', agent: this.session.agent, sessionId });
      }
      yield* this.session.emit({ type: 'session_configured', model, permissionMode });
      return [rpc, sessionId] as const;
    });
  }

  /**
   * Reports why the turn failed and ends it. A closed connection is left to its watcher, which
   * reports it as a crash unless the session stopped it.
   */
  private turnFailed(turn: T, error: TurnError): Effect.Effect<void> {
    if (error._tag === 'ConnectionClosed') {
      return Effect.void;
    }
    const { code, message } = error._tag === 'RpcError' ? this.rpcFailure(error) : error;
    return Effect.zipRight(turn.reportError(code, message), this.session.endTurn(turn, 'error'));
  }

  private rpcFailure(error: RpcError): AgentFailure {
    return this.protocol.rpcFailure?.(error) ?? new AgentFailure({ code: 'agent_error', message: error.message || `${AGENT_NAMES[this.session.agent]} reported an error.` });
  }

  /** The connection closed: unless that was expected, the agent crashed. */
  private closed(connection: Connection, reason: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.session.stopped() || this.connection !== connection) {
        return Effect.void;
      }
      return Effect.zipRight(this.stop(), this.session.crashed(reason));
    });
  }
}
