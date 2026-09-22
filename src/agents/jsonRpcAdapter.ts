import { Data, Effect, ExecutionStrategy, Exit, Option, Scope, type Context } from 'effect';
import type { Ids } from '../ids';
import type { AdapterOptions } from './adapter';
import { BaseAdapter } from './baseAdapter';
import { AGENT_NAMES, type AgentErrorCode, type ContentBlock } from './events';
import type { Executables } from './findExecutable';
import { JsonRpcConnection, type ConnectionClosed, type MalformedMessage, type RpcError } from './jsonRpc';
import type { ModeSettings } from './modes';
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

interface Connection {
  readonly rpc: JsonRpcConnection;
  /** Holds the process and the reader; closing it kills the process. */
  readonly scope: Scope.CloseableScope;
}

/**
 * An adapter for an agent that runs as a JSON-RPC server over stdio (Codex's app-server, Cursor's
 * ACP server). The agent assigns the session ID, so the session is announced once the first turn
 * has created it.
 *
 * The process starts with the first prompt and serves every turn after it. If it dies, the running
 * turn ends as `error` and the next prompt starts a new process that resumes the session. The
 * process lives in a scope forked from the adapter's, so closing the adapter's scope stops it.
 */
export abstract class JsonRpcAdapter<T extends Turn> extends BaseAdapter<T> {
  /** The arguments that start the CLI's JSON-RPC server. */
  protected abstract readonly args: ReadonlyArray<string>;
  /** The native session, once the agent has created it. It is resumed after a crash. */
  protected sessionId: string | undefined;
  private connection: Connection | undefined;

  protected constructor(
    options: AdapterOptions,
    private readonly stdio: Context.Tag.Service<Stdio>,
    executables: Context.Tag.Service<Executables>,
    ids: Context.Tag.Service<Ids>,
    modeSettings: Context.Tag.Service<ModeSettings>,
    scope: Scope.Scope
  ) {
    super(options, executables, ids, modeSettings, scope);
  }

  /** Initialises a new process and opens a session, resuming `resume` if given. */
  protected abstract openSession(rpc: JsonRpcConnection, resume: Option.Option<string>): Effect.Effect<OpenedSession, TurnError>;

  /** Sends the prompt. The turn ends when the agent says so, through `endTurn`. */
  protected abstract sendPrompt(rpc: JsonRpcConnection, sessionId: string, turn: T, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void, TurnError>;

  protected abstract handleNotification(method: string, params: WireMessage | undefined): Effect.Effect<void, MalformedMessage>;

  /**
   * Answers a request from the agent; by default none are supported, so each gets "method not
   * found". The answer itself is an effect run on a fiber of the connection's, so a request the
   * user has to answer does not hold up the agent's other messages.
   */
  protected handleRequest(_method: string, _params: WireMessage | undefined): Effect.Effect<Option.Option<Effect.Effect<WireMessage>>, MalformedMessage> {
    return Effect.succeedNone;
  }

  /** How an error the agent answered a request with is shown; override to recognise the agent's own codes. */
  protected rpcFailure(error: RpcError): AgentFailure {
    return new AgentFailure({ code: 'agent_error', message: error.message || `${AGENT_NAMES[this.agent]} reported an error.` });
  }

  protected runTurn(turn: T, executable: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void> {
    return this.connect(executable).pipe(
      // A cancel that arrived while the session was opening had nothing to interrupt yet.
      Effect.flatMap(([rpc, sessionId]) => (turn.cancelRequested ? this.endTurn(turn, 'cancelled') : this.sendPrompt(rpc, sessionId, turn, prompt))),
      Effect.catchAll((error) => this.turnFailed(turn, error))
    );
  }

  /** Runs `f` against the open session, if there is one. */
  protected withSession<E>(f: (rpc: JsonRpcConnection, sessionId: string) => Effect.Effect<void, E>): Effect.Effect<void, E> {
    return Effect.suspend(() => {
      const { connection, sessionId } = this;
      return connection && sessionId !== undefined ? f(connection.rpc, sessionId) : Effect.void;
    });
  }

  protected stop(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const connection = this.connection;
      this.connection = undefined;
      return connection ? Scope.close(connection.scope, Exit.void) : Effect.void;
    });
  }

  /** Starts the agent if it is not running. If it cannot open the session, the process is stopped. */
  private connect(executable: string): Effect.Effect<readonly [JsonRpcConnection, string], TurnError> {
    return Effect.gen(this, function* () {
      if (this.connection && this.sessionId !== undefined) {
        return [this.connection.rpc, this.sessionId] as const;
      }
      const scope = yield* Scope.fork(this.scope, ExecutionStrategy.sequential);
      const process = yield* this.stdio.spawn({ executable, args: this.args, cwd: this.options.cwd }).pipe(Scope.extend(scope));
      const rpc = yield* JsonRpcConnection.open(process, {
        notification: (method, params) => Effect.suspend(() => this.handleNotification(method, params)),
        request: (method, params) => Effect.suspend(() => this.handleRequest(method, params)),
      }).pipe(Scope.extend(scope));
      const connection: Connection = { rpc, scope };
      this.connection = connection;
      yield* Effect.forkIn(Effect.flatMap(rpc.awaitClosed(), (reason) => this.closed(connection, reason)), this.scope);
      yield* Effect.logDebug(`Started ${AGENT_NAMES[this.agent]} (${executable} ${this.args.join(' ')}) in ${this.options.cwd}`);

      const { sessionId, model, permissionMode } = yield* this.openSession(rpc, Option.fromNullable(this.sessionId)).pipe(
        // A closed connection is reported as a crash once its watcher sees it.
        Effect.tapError((error) => (error._tag === 'ConnectionClosed' ? Effect.void : this.stop()))
      );
      if (sessionId !== this.sessionId) {
        this.sessionId = sessionId;
        yield* this.emit({ type: 'session_started', agent: this.agent, sessionId });
      }
      yield* this.emit({ type: 'session_configured', model, permissionMode });
      return [rpc, sessionId] as const;
    });
  }

  /**
   * Reports why the turn failed and ends it. A closed connection is left to its watcher, which
   * reports it as a crash unless the adapter stopped it.
   */
  private turnFailed(turn: T, error: TurnError): Effect.Effect<void> {
    if (error._tag === 'ConnectionClosed') {
      return Effect.void;
    }
    const { code, message } = error._tag === 'RpcError' ? this.rpcFailure(error) : error;
    return Effect.zipRight(turn.reportError(code, message), this.endTurn(turn, 'error'));
  }

  /** The connection closed: unless that was expected, the agent crashed. */
  private closed(connection: Connection, reason: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.disposed || this.connection !== connection) {
        return Effect.void;
      }
      return Effect.zipRight(this.stop(), this.crashed(reason));
    });
  }
}
