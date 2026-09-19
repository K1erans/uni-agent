import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Context, Deferred, Effect, Layer, Option, Queue, Runtime, type Scope, Stream } from 'effect';
import { Ids } from '../../ids';
import { TurnInProgress, type AgentAdapter, type EventSink } from '../adapter';
import type { AgentErrorCode, AgentEvent, ContentBlock, StopReason } from '../events';
import { Executables } from '../findExecutable';
import { Turn } from '../turn';

/** The part of the Agent SDK's `Query` the adapter uses; lets tests substitute a fake agent. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close'>;

export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

/** Starts native Claude sessions; defaults to the Agent SDK's `query`. */
export class ClaudeSdk extends Context.Tag('uni-agent/ClaudeSdk')<ClaudeSdk, { readonly query: ClaudeQueryFn }>() {
  static readonly live = Layer.succeed(ClaudeSdk, { query: sdkQuery });
}

export interface ClaudeAdapterOptions {
  /** The thread's working directory. */
  readonly cwd: string;
  /** The `uniAgent.claude.executablePath` setting; none means search PATH for `claude`. */
  readonly executablePath: Option.Option<string>;
  readonly onEvent: EventSink;
}

const STDERR_TAIL_LINES = 20;
const NOT_SIGNED_IN_ERRORS = new Set<SDKAssistantMessage['error']>(['authentication_failed', 'oauth_org_not_allowed']);
/** Message types Claude sends only once it has written the session. */
const SESSION_MESSAGE_TYPES = new Set<SDKMessage['type']>(['stream_event', 'assistant', 'result']);

class ClaudeTurn extends Turn {
  /** API message IDs whose content arrived as stream events, so their complete copies are skipped. */
  readonly streamedMessageIds = new Set<string>();
  /** The API message currently streaming, which content-block deltas belong to. */
  streamingMessageId: string | undefined;
}

/** One running `claude` process, fed user messages through a streaming-input query. */
class Connection {
  readonly query: ClaudeQuery;
  private readonly stderrTail: string[] = [];

  private constructor(
    private readonly input: Queue.Queue<SDKUserMessage>,
    query: ClaudeQueryFn,
    options: Options,
    runtime: Runtime.Runtime<never>
  ) {
    this.query = query({
      prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
      options: { ...options, stderr: (data) => Runtime.runSync(runtime, this.recordStderr(data)) },
    });
  }

  static open(query: ClaudeQueryFn, options: Options): Effect.Effect<Connection> {
    return Effect.gen(function* () {
      return new Connection(yield* Queue.unbounded<SDKUserMessage>(), query, options, yield* Effect.runtime<never>());
    });
  }

  send(message: SDKUserMessage): Effect.Effect<void> {
    return Effect.asVoid(Queue.offer(this.input, message));
  }

  /** Everything Claude sends; fails with why the process broke off. */
  messages(): Stream.Stream<SDKMessage, string> {
    return Stream.fromAsyncIterable(this.query, (err) => (err instanceof Error ? err.message : String(err)));
  }

  interrupt(): Effect.Effect<void> {
    return Effect.tryPromise(() => this.query.interrupt()).pipe(
      Effect.asVoid,
      Effect.catchAll((error) => Effect.logWarning('Could not interrupt Claude Code', error))
    );
  }

  /** The last lines Claude wrote to stderr, which usually explain a crash. */
  stderr(): string {
    return this.stderrTail.join('\n').trim();
  }

  close(): Effect.Effect<void> {
    return Effect.zipRight(Queue.shutdown(this.input), Effect.sync(() => this.query.close()));
  }

  private recordStderr(data: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const line of data.split('\n')) {
        if (line.trim()) {
          yield* Effect.logDebug(`[claude stderr] ${line}`);
          this.stderrTail.push(line);
        }
      }
      this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_TAIL_LINES));
    });
  }
}

/**
 * Drives the user's own, unmodified `claude` binary through the Claude Agent SDK. Uni Agent never
 * touches Claude credentials: the binary signs in and authenticates by itself.
 *
 * The session ID is generated here and handed to Claude, so it is known before the first prompt.
 * One long-lived streaming-input query serves every turn; if the process dies, the next prompt
 * starts a new one that resumes the session. The query runs in the adapter's scope, so closing
 * the scope stops it.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;

  private connection: Connection | undefined;
  private turn: ClaudeTurn | undefined;
  /** Whether Claude has written the session, so a restart must resume it rather than create it. */
  private sessionExists = false;
  private disposed = false;

  private constructor(
    readonly sessionId: string,
    private readonly options: ClaudeAdapterOptions,
    private readonly sdk: Context.Tag.Service<ClaudeSdk>,
    private readonly executables: Context.Tag.Service<Executables>,
    private readonly ids: Context.Tag.Service<Ids>,
    private readonly scope: Scope.Scope
  ) {}

  static make(options: ClaudeAdapterOptions): Effect.Effect<ClaudeAdapter, never, ClaudeSdk | Executables | Ids | Scope.Scope> {
    return Effect.gen(function* () {
      const ids = yield* Ids;
      const adapter = new ClaudeAdapter(yield* ids.next, options, yield* ClaudeSdk, yield* Executables, ids, yield* Effect.scope);
      yield* Effect.addFinalizer(() => adapter.dispose());
      yield* adapter.emit({ type: 'session_started', agent: adapter.agent, sessionId: adapter.sessionId });
      if (Option.isNone(yield* adapter.findClaude())) {
        yield* adapter.reportBinaryMissing();
      }
      return adapter;
    });
  }

  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason, TurnInProgress> {
    return Effect.gen(this, function* () {
      if (this.turn) {
        return yield* new TurnInProgress({ sessionId: this.sessionId });
      }
      const turnId = yield* this.ids.next;
      yield* this.emit({ type: 'turn_started', turnId, prompt });

      const executable = yield* this.findClaude();
      if (Option.isNone(executable)) {
        yield* this.reportBinaryMissing(turnId);
        yield* this.emit({ type: 'turn_ended', turnId, stopReason: 'error' });
        return 'error';
      }

      const turn = new ClaudeTurn(turnId, yield* Deferred.make<StopReason>(), this.options.onEvent);
      this.turn = turn;
      const connection = yield* this.connect(executable.value);
      yield* connection.send({
        type: 'user',
        message: { role: 'user', content: prompt.map((block) => ({ type: 'text', text: block.text })) },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
      });
      return yield* turn.awaitEnd();
    });
  }

  cancel(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const { turn, connection } = this;
      if (!turn || !connection) {
        return Effect.void;
      }
      turn.cancelRequested = true;
      return connection.interrupt();
    });
  }

  private dispose(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.disposed = true;
      const connection = this.connection;
      this.connection = undefined;
      if (connection) {
        yield* connection.close();
      }
      if (this.turn) {
        yield* this.endTurn(this.turn, 'cancelled');
      }
    });
  }

  private connect(executable: string): Effect.Effect<Connection> {
    return Effect.gen(this, function* () {
      if (this.connection) {
        return this.connection;
      }
      const connection = yield* Connection.open(this.sdk.query, {
        cwd: this.options.cwd,
        pathToClaudeCodeExecutable: executable,
        ...(this.sessionExists ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'uni-agent' },
      });
      this.connection = connection;
      yield* Effect.logDebug(`Started Claude Code (${executable}) for session ${this.sessionId}`);
      yield* Effect.forkIn(this.consume(connection), this.scope);
      return connection;
    });
  }

  private consume(connection: Connection): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const failure = yield* connection.messages().pipe(
        // Handlers update the turn state, so they run only when the consumer reaches each message.
        Stream.runForEach((message) => Effect.suspend(() => this.handle(message))),
        Effect.as('the process exited'),
        Effect.merge
      );
      if (this.disposed || this.connection !== connection) {
        return;
      }
      this.connection = undefined;
      yield* connection.close();
      const stderr = connection.stderr();
      yield* Effect.logDebug(`Claude Code stopped: ${failure}`);
      yield* this.emit({
        type: 'error',
        turnId: this.turn?.id,
        code: 'process_crashed',
        message: `Claude Code stopped unexpectedly: ${failure}` + (stderr ? `\n\n${stderr}` : ''),
      });
      if (this.turn) {
        yield* this.endTurn(this.turn, 'error');
      }
    });
  }

  private handle(message: SDKMessage): Effect.Effect<void> {
    if (SESSION_MESSAGE_TYPES.has(message.type)) {
      this.sessionExists = true;
    }
    switch (message.type) {
      case 'stream_event':
        return this.handleStreamEvent(message);
      case 'assistant':
        return this.handleAssistant(message);
      case 'result':
        return this.handleResult(message);
      default:
        return Effect.void;
    }
  }

  private handleStreamEvent({ event, parent_tool_use_id }: SDKPartialAssistantMessage): Effect.Effect<void> {
    const turn = this.turn;
    // Subagent traffic belongs to its tool call, which a later ticket renders.
    if (!turn || parent_tool_use_id !== null) {
      return Effect.void;
    }
    if (event.type === 'message_start') {
      turn.streamingMessageId = event.message.id;
      turn.streamedMessageIds.add(event.message.id);
    } else if (event.type === 'content_block_delta' && turn.streamingMessageId) {
      const messageId = `${turn.streamingMessageId}:${event.index}`;
      if (event.delta.type === 'text_delta') {
        return turn.chunk('agent_message_chunk', messageId, event.delta.text);
      } else if (event.delta.type === 'thinking_delta') {
        return turn.chunk('agent_thought_chunk', messageId, event.delta.thinking);
      }
    }
    return Effect.void;
  }

  private handleAssistant({ message, error, parent_tool_use_id }: SDKAssistantMessage): Effect.Effect<void> {
    const turn = this.turn;
    if (!turn || parent_tool_use_id !== null) {
      return Effect.void;
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    if (error) {
      const code = NOT_SIGNED_IN_ERRORS.has(error) ? 'not_signed_in' : 'agent_error';
      return turn.reportError(code, errorMessage(code, text));
    }
    // Complete copies of streamed messages carry nothing new; ones that never streamed (such as
    // messages Claude Code synthesises itself) are shown whole.
    if (turn.streamedMessageIds.has(message.id)) {
      return Effect.void;
    }
    return Effect.forEach(
      message.content,
      (block, index) => (block.type === 'text' ? turn.chunk('agent_message_chunk', `${message.id}:${index}`, block.text) : Effect.void),
      { discard: true }
    );
  }

  private handleResult(result: SDKResultMessage): Effect.Effect<void> {
    const turn = this.turn;
    if (!turn) {
      return Effect.void;
    }
    const stopReason = turn.cancelRequested ? 'cancelled' : stopReasonOf(result);
    if (stopReason !== 'error') {
      return this.endTurn(turn, stopReason);
    }
    const [detail, status] =
      result.subtype === 'success' ? [result.result, result.api_error_status] : [result.errors.join('\n'), undefined];
    const code = status === 401 ? 'not_signed_in' : 'agent_error';
    return Effect.zipRight(turn.reportError(code, errorMessage(code, detail)), this.endTurn(turn, 'error'));
  }

  private endTurn(turn: Turn, stopReason: StopReason): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.turn = undefined;
      return turn.end(stopReason);
    });
  }

  private reportBinaryMissing(turnId?: string): Effect.Effect<void> {
    return this.emit({ type: 'error', turnId, code: 'binary_missing', message: binaryMissingMessage(this.options.executablePath) });
  }

  private emit(event: AgentEvent): Effect.Effect<void> {
    return this.options.onEvent(event);
  }

  private findClaude(): Effect.Effect<Option.Option<string>> {
    return this.executables.find('claude', this.options.executablePath);
  }
}

/** Why a result ends its turn; `error` when Claude reports the turn failed. */
function stopReasonOf(result: SDKResultMessage): StopReason {
  if (result.subtype === 'success' && !result.is_error) {
    return result.stop_reason === 'max_tokens' || result.stop_reason === 'refusal' ? result.stop_reason : 'end_turn';
  }
  return result.subtype === 'error_max_turns' ? 'max_turn_requests' : 'error';
}

/** The message shown for an error Claude reported, given the detail it sent. */
function errorMessage(code: AgentErrorCode, detail: string): string {
  return code === 'not_signed_in'
    ? 'Claude Code is not signed in. Run `claude` in a terminal, sign in, then try again.' + (detail ? `\n\n${detail}` : '')
    : detail || 'Claude Code reported an error.';
}

function binaryMissingMessage(executablePath: Option.Option<string>): string {
  return Option.match(executablePath, {
    onSome: (path) => `Claude Code was not found at "${path}", the path set in uniAgent.claude.executablePath.`,
    onNone: () => 'Claude Code ("claude") was not found on PATH. Install Claude Code, or set uniAgent.claude.executablePath to its location.',
  });
}
