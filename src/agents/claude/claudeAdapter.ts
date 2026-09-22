import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Context, type Deferred, Effect, Layer, Option, Queue, Runtime, Schema, type Scope, Stream } from 'effect';
import { Ids } from '../../ids';
import { ModeChangeFailed, notSignedInMessage, type AdapterOptions } from '../adapter';
import { BaseAdapter } from '../baseAdapter';
import type { AgentErrorCode, ContentBlock, StopReason, ToolCall, ToolCallStatus } from '../events';
import { Executables } from '../findExecutable';
import { ModeSettings } from '../modes';
import { WireMessage } from '../traffic';
import { Turn } from '../turn';
import { ClaudeModeOverrides, claudeNoLooser, claudePermissionMode } from './claudeModes';
import { describeTool, permissionOptions, ToolResultContent, toolResultContent } from './claudeTools';

/** The part of the Agent SDK's `Query` the adapter uses; lets tests substitute a fake agent. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close' | 'setPermissionMode'>;

export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

/** Starts native Claude sessions; defaults to the Agent SDK's `query`. */
export class ClaudeSdk extends Context.Tag('uni-agent/ClaudeSdk')<ClaudeSdk, { readonly query: ClaudeQueryFn }>() {
  static readonly live = Layer.succeed(ClaudeSdk, { query: sdkQuery });
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
  /** Whether Claude was started able to bypass permissions; it cannot be switched into that mode otherwise. */
  readonly canBypass: boolean;
  private readonly stderrTail: string[] = [];

  private constructor(
    private readonly input: Queue.Queue<SDKUserMessage>,
    query: ClaudeQueryFn,
    options: Options,
    runtime: Runtime.Runtime<never>
  ) {
    this.canBypass = options.allowDangerouslySkipPermissions === true;
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

  /** Switches the running Claude; fails with why when it refuses, so the caller keeps the mode it had. */
  setPermissionMode(mode: PermissionMode): Effect.Effect<void, string> {
    return Effect.tryPromise({
      try: () => this.query.setPermissionMode(mode),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    });
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
export class ClaudeAdapter extends BaseAdapter<ClaudeTurn> {
  readonly agent = 'claude' as const;
  protected readonly command = 'claude';

  private connection: Connection | undefined;
  /** Whether Claude has written the session, so a restart must resume it rather than create it. */
  private sessionExists = false;

  private constructor(
    readonly sessionId: string,
    options: AdapterOptions,
    private readonly sdk: Context.Tag.Service<ClaudeSdk>,
    executables: Context.Tag.Service<Executables>,
    ids: Context.Tag.Service<Ids>,
    modeSettings: Context.Tag.Service<ModeSettings>,
    scope: Scope.Scope
  ) {
    super(options, executables, ids, modeSettings, scope);
  }

  static make(options: AdapterOptions): Effect.Effect<ClaudeAdapter, never, ClaudeSdk | Executables | Ids | ModeSettings | Scope.Scope> {
    return Effect.gen(function* () {
      const ids = yield* Ids;
      const adapter = new ClaudeAdapter(yield* ids.next, options, yield* ClaudeSdk, yield* Executables, ids, yield* ModeSettings, yield* Effect.scope);
      yield* adapter.emit({ type: 'session_started', agent: adapter.agent, sessionId: adapter.sessionId });
      yield* adapter.start();
      return adapter;
    });
  }

  protected newTurn(id: string, ended: Deferred.Deferred<StopReason>): ClaudeTurn {
    return new ClaudeTurn(id, ended, this.options.onEvent);
  }

  protected runTurn(turn: ClaudeTurn, executable: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void> {
    return Effect.flatMap(this.connect(executable), (connection) =>
      // A cancel that arrived before Claude started had nothing to interrupt, so the prompt is never sent.
      turn.cancelRequested
        ? this.endTurn(turn, 'cancelled')
        : connection.send({
            type: 'user',
            message: { role: 'user', content: prompt.map((block) => ({ type: 'text', text: block.text })) },
            parent_tool_use_id: null,
            origin: { kind: 'human' },
          })
    );
  }

  protected interrupt(): Effect.Effect<void> {
    return this.connection ? this.connection.interrupt() : Effect.void;
  }

  protected stop(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const connection = this.connection;
      this.connection = undefined;
      return connection ? connection.close() : Effect.void;
    });
  }

  /**
   * Switches the running Claude to the mode's permission mode. Bypassing permissions needs a Claude
   * started able to, so a Claude started without it keeps its current, more restrictive mode until
   * the next prompt restarts it. If Claude refuses the switch, it fails, so the thread keeps showing
   * the mode Claude still runs in.
   */
  protected applyMode(): Effect.Effect<void, ModeChangeFailed> {
    return Effect.gen(this, function* () {
      const permissionMode = yield* this.permissionMode();
      const connection = this.connection;
      if (!connection) {
        return;
      }
      if (permissionMode === 'bypassPermissions' && !connection.canBypass) {
        return yield* Effect.logDebug('Claude Code switches to bypassing permissions when it restarts for the next prompt');
      }
      yield* Effect.mapError(connection.setPermissionMode(permissionMode), (reason) => new ModeChangeFailed({ agent: this.agent, mode: this.mode, reason }));
    });
  }

  private permissionMode(): Effect.Effect<PermissionMode> {
    return this.native(claudePermissionMode, ClaudeModeOverrides, claudeNoLooser);
  }

  private connect(executable: string): Effect.Effect<Connection> {
    return Effect.gen(this, function* () {
      const permissionMode = yield* this.permissionMode();
      // Only a Claude started able to bypass permissions can, so one started without is restarted.
      // The session exists by then, so the new process resumes it.
      if (this.connection && permissionMode === 'bypassPermissions' && !this.connection.canBypass) {
        yield* this.stop();
      }
      if (this.connection) {
        return this.connection;
      }
      const runtime = yield* Effect.runtime<never>();
      const connectionOptions: Options = {
        cwd: this.options.cwd,
        pathToClaudeCodeExecutable: executable,
        permissionMode,
        // Claude is only started able to bypass permissions when it starts bypassing them.
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
        canUseTool: this.canUseTool(runtime),
        ...(this.sessionExists ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'uni-agent' },
      };
      if (this.options.model) {
        connectionOptions.model = this.options.model;
      }
      const connection = yield* Connection.open(this.sdk.query, connectionOptions);
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
      yield* this.crashed(failure + (stderr ? `\n\n${stderr}` : ''));
    });
  }

  private handle(message: SDKMessage): Effect.Effect<void> {
    if (SESSION_MESSAGE_TYPES.has(message.type)) {
      this.sessionExists = true;
    }
    switch (message.type) {
      case 'system':
        return message.subtype === 'init'
          ? this.emit({ type: 'session_configured', model: message.model, permissionMode: message.permissionMode })
          : Effect.void;
      case 'stream_event':
        return this.handleStreamEvent(message);
      case 'assistant':
        return this.handleAssistant(message);
      case 'user':
        return this.handleUser(message);
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
    // Text that streamed carries nothing new in its complete copy; text that never streamed (such
    // as messages Claude Code synthesises itself) is shown whole. Tool calls never stream whole,
    // so they are always read from here.
    const streamed = turn.streamedMessageIds.has(message.id);
    return Effect.forEach(
      message.content,
      (block, index) => {
        if (block.type === 'tool_use') {
          // Claude runs a tool as soon as it has permission, so one it still has to ask about is
          // already shown as pending by `canUseTool`.
          return Option.match(decodeToolUse(block), {
            onNone: () => Effect.logDebug(`Skipped a ${block.name} tool call whose input is not JSON`),
            onSome: ({ id, name, input }) => this.showToolCall(turn, id, name, input, 'in_progress'),
          });
        }
        return block.type === 'text' && !streamed ? turn.chunk('agent_message_chunk', `${message.id}:${index}`, block.text) : Effect.void;
      },
      { discard: true }
    );
  }

  /** Tool results come back as the user messages Claude writes for itself. */
  private handleUser({ message, parent_tool_use_id }: SDKUserMessage): Effect.Effect<void> {
    const turn = this.turn;
    if (!turn || parent_tool_use_id !== null || !Array.isArray(message.content)) {
      return Effect.void;
    }
    return Effect.forEach(
      message.content,
      (block) =>
        block.type === 'tool_result'
          ? turn.updateToolCall({
              toolCallId: block.tool_use_id,
              status: block.is_error ? 'failed' : 'completed',
              content: Option.match(decodeToolResult(block.content), { onNone: () => [], onSome: toolResultContent }),
            })
          : Effect.void,
      { discard: true }
    );
  }

  /** Shows a tool call the first time it is seen, whether that is the tool use or the ask about it. */
  private showToolCall(turn: ClaudeTurn, toolCallId: string, name: string, input: WireMessage, status: ToolCallStatus): Effect.Effect<ToolCall> {
    const { title, kind } = describeTool(name, input);
    const toolCall: ToolCall = { toolCallId, title, kind, status, rawInput: input };
    // A tool call already shown keeps the status it has: an ask shows it as pending, and the
    // message that asks for the tool must not then show it as running.
    return Effect.suspend(() => (turn.hasToolCall(toolCallId) ? Effect.succeed(toolCall) : Effect.as(turn.toolCall(toolCall), toolCall)));
  }

  /**
   * Claude asks permission through a callback that answers with a Promise, so the ask is bridged
   * into the adapter's runtime and the Promise settles when the user answers. An answer that never
   * comes is cancelled when the turn ends, so Claude is never left waiting.
   */
  private canUseTool(runtime: Runtime.Runtime<never>): CanUseTool {
    return async (toolName, input, request) => Runtime.runPromise(runtime)(this.askPermission(toolName, input, request));
  }

  private askPermission(toolName: string, input: ToolInput, request: PermissionRequest): Effect.Effect<PermissionResult> {
    return Effect.gen(this, function* () {
      const turn = this.turn;
      if (!turn) {
        return DENIED_OUTSIDE_TURN;
      }
      const toolCall = yield* this.showToolCall(turn, request.toolUseID, toolName, toWire(input), 'pending');
      const suggestions = request.suggestions ?? [];
      const canAlwaysAllow = suggestions.length > 0 && !request.suppressAlwaysAllowRule;
      const outcome = yield* this.approvals.ask(turn.id, toolCall, permissionOptions(canAlwaysAllow));
      if (outcome.outcome === 'cancelled') {
        yield* turn.updateToolCall({ toolCallId: toolCall.toolCallId, status: 'failed' });
        return CANCELLED;
      }
      const allowed = outcome.optionId !== 'deny';
      yield* turn.updateToolCall({ toolCallId: toolCall.toolCallId, status: allowed ? 'in_progress' : 'failed' });
      if (!allowed) {
        return DENIED;
      }
      return outcome.optionId === 'allow_always' ? { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions } : { behavior: 'allow', updatedInput: input };
    });
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
}

/** A tool's input, as Claude's permission callback passes it; it goes back unchanged when the user allows the call. */
type ToolInput = Parameters<CanUseTool>[1];

/** What Claude says about a tool call it is asking permission for, beyond the tool's name and input. */
type PermissionRequest = Parameters<CanUseTool>[2];

const decodeWire = Schema.decodeUnknownOption(WireMessage);
const decodeToolResult = Schema.decodeUnknownOption(ToolResultContent);
/** A tool use as the assistant message carries it; its input is the tool's own JSON. */
const decodeToolUse = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String, name: Schema.String, input: WireMessage }));

/** A tool's input as JSON, for showing it in the thread; anything that is not JSON is shown as nothing. */
function toWire(input: ToolInput): WireMessage {
  return Option.getOrElse(decodeWire(input), (): WireMessage => null);
}

const DENIED: PermissionResult = { behavior: 'deny', message: 'The user denied this tool call.' };
const CANCELLED: PermissionResult = { behavior: 'deny', message: 'The turn was stopped before the user answered.', interrupt: true };
const DENIED_OUTSIDE_TURN: PermissionResult = { behavior: 'deny', message: 'Uni Agent has no turn running to ask the user about this tool call.' };

/** Why a result ends its turn; `error` when Claude reports the turn failed. */
function stopReasonOf(result: SDKResultMessage): StopReason {
  if (result.subtype === 'success' && !result.is_error) {
    return result.stop_reason === 'max_tokens' || result.stop_reason === 'refusal' ? result.stop_reason : 'end_turn';
  }
  return result.subtype === 'error_max_turns' ? 'max_turn_requests' : 'error';
}

/** The message shown for an error Claude reported, given the detail it sent. */
function errorMessage(code: AgentErrorCode, detail: string): string {
  return code === 'not_signed_in' ? notSignedInMessage('claude', 'claude', detail) : detail || 'Claude Code reported an error.';
}
