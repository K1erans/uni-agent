import { Effect, Option, Predicate, Schema, type Deferred, type Scope } from 'effect';
import { Ids } from '../../ids';
import { notSignedInMessage, type AdapterOptions, type ModeChangeFailed } from '../adapter';
import type { AgentErrorCode, ContentBlock, StopReason, ToolCall } from '../events';
import { Executables } from '../findExecutable';
import { ModeSettings } from '../modes';
import { decodeMessage, type JsonRpcConnection, type MalformedMessage } from '../jsonRpc';
import { AgentFailure, CLIENT_INFO, JsonRpcAdapter, type OpenedSession, type TurnError } from '../jsonRpcAdapter';
import { Stdio } from '../stdio';
import { WireMessage } from '../traffic';
import { Turn, type ChunkKind } from '../turn';
import { CodexModeOverrides, codexNoLooser, codexPolicy, sandboxPolicy } from './codexModes';
import { AvailableDecisions, CODEX_CANCELLED, codexApproval, ThreadItem, toolCallOf, type CodexApproval, type ItemLifecycle } from './codexItems';

// The parts of Codex's app-server protocol the adapter reads (`codex app-server generate-ts`).

const AccountRead = Schema.Struct({ account: Schema.NullOr(WireMessage), requiresOpenaiAuth: Schema.Boolean });

/** The result of `thread/start` and `thread/resume`. */
const ThreadOpened = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.String,
  // A named policy, or an object for a granular one.
  approvalPolicy: WireMessage,
});

const TurnStarted = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });

const TurnFailure = Schema.Struct({
  message: Schema.String,
  // A named error kind, or an object for kinds that carry an HTTP status.
  codexErrorInfo: Schema.NullOr(WireMessage),
  additionalDetails: Schema.NullOr(Schema.String),
});

const Delta = Schema.Struct({ threadId: Schema.String, itemId: Schema.String, delta: Schema.String });

const SummaryDelta = Schema.Struct({ ...Delta.fields, summaryIndex: Schema.Number });

const ItemNews = Schema.Struct({ threadId: Schema.String, item: ThreadItem });

const ErrorNotification = Schema.Struct({ threadId: Schema.String, error: TurnFailure, willRetry: Schema.Boolean });

const TurnCompleted = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String, status: Schema.String, error: Schema.NullOr(TurnFailure) }),
});

/** The notifications the adapter reads; any other is logged and skipped. */
export const CODEX_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/started',
  'item/completed',
  'error',
  'turn/completed',
]);

/** The approval requests the adapter answers; the option IDs are the decisions Codex expects back. */
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval';

const CommandApproval = Schema.Struct({
  itemId: Schema.String,
  availableDecisions: AvailableDecisions,
  command: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  // Set when Codex is asking to reach the network rather than only to run the command.
  networkApprovalContext: Schema.optional(Schema.NullOr(Schema.Struct({ host: Schema.String }))),
});

const FileChangeApproval = Schema.Struct({
  itemId: Schema.String,
  availableDecisions: AvailableDecisions,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  grantRoot: Schema.optional(Schema.NullOr(Schema.String)),
});

class CodexTurn extends Turn {
  /** Codex's own ID for the turn, known once `turn/start` answers; `turn/interrupt` needs it. */
  codexTurnId: string | undefined;
  /** Message IDs whose text arrived as deltas, so their completed items carry nothing new. */
  private readonly streamed = new Set<string>();

  stream(kind: ChunkKind, messageId: string, text: string): Effect.Effect<void> {
    this.streamed.add(messageId);
    return this.chunk(kind, messageId, text);
  }

  /** Shows text of a completed item that never streamed, such as a message Codex did not stream. */
  complete(kind: ChunkKind, messageId: string, text: string): Effect.Effect<void> {
    return this.streamed.has(messageId) ? Effect.void : this.chunk(kind, messageId, text);
  }
}

/**
 * Drives the user's own `codex` binary through its app-server: JSON-RPC over the stdio of
 * `codex app-server`. Uni Agent never touches Codex credentials; it only asks whether the binary
 * is signed in.
 *
 * A thread maps onto one Codex thread, and each prompt onto one Codex turn. Codex streams every
 * turn item through a started → delta → completed lifecycle: its item ID becomes the message ID,
 * deltas become chunks, and a completed item fills in any text that never streamed. Items of
 * other threads, such as sub-agents', are skipped.
 */
export class CodexAdapter extends JsonRpcAdapter<CodexTurn> {
  readonly agent = 'codex' as const;
  protected readonly command = 'codex';
  protected readonly args = ['app-server'];

  static make(options: AdapterOptions): Effect.Effect<CodexAdapter, never, Stdio | Executables | Ids | ModeSettings | Scope.Scope> {
    return Effect.gen(function* () {
      const adapter = new CodexAdapter(options, yield* Stdio, yield* Executables, yield* Ids, yield* ModeSettings, yield* Effect.scope);
      yield* adapter.start();
      return adapter;
    });
  }

  protected newTurn(id: string, ended: Deferred.Deferred<StopReason>): CodexTurn {
    return new CodexTurn(id, ended, this.options.onEvent);
  }

  protected openSession(rpc: JsonRpcConnection, resume: Option.Option<string>): Effect.Effect<OpenedSession, TurnError> {
    return Effect.gen(this, function* () {
      yield* rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, WireMessage);
      yield* rpc.notify('initialized');
      // Codex retries a signed-out turn for a while before failing it with no sign of why, so ask first.
      const { account, requiresOpenaiAuth } = yield* rpc.request('account/read', {}, AccountRead);
      if (account === null && requiresOpenaiAuth) {
        return yield* new AgentFailure({ code: 'not_signed_in', message: notSignedInMessage('codex', 'codex login') });
      }
      const { thread, model, approvalPolicy } = yield* Option.match(resume, {
        onNone: () => rpc.request('thread/start', { cwd: this.options.cwd }, ThreadOpened),
        onSome: (threadId) => rpc.request('thread/resume', { threadId }, ThreadOpened),
      });
      return { sessionId: thread.id, model, permissionMode: Predicate.isString(approvalPolicy) ? approvalPolicy : 'custom' };
    });
  }

  protected sendPrompt(rpc: JsonRpcConnection, threadId: string, turn: CodexTurn, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void, TurnError> {
    return Effect.gen(this, function* () {
      const input = prompt.map((block) => ({ type: 'text', text: block.text, text_elements: [] }));
      // Every turn names its policy, so a mode changed since the last turn applies to this one.
      const { approvalPolicy, sandbox } = yield* this.native(codexPolicy, CodexModeOverrides, codexNoLooser);
      const started = yield* rpc.request('turn/start', { threadId, input, approvalPolicy, sandboxPolicy: sandboxPolicy(sandbox) }, TurnStarted);
      turn.codexTurnId = started.turn.id;
      // A cancel that arrived before Codex named the turn could not interrupt it then.
      if (turn.cancelRequested) {
        yield* this.interrupt(turn);
      }
    });
  }

  /** Codex takes its approval policy and sandbox with each turn, so a new mode applies from the next one. */
  protected applyMode(): Effect.Effect<void, ModeChangeFailed> {
    return Effect.void;
  }

  protected interrupt(turn: CodexTurn): Effect.Effect<void> {
    const turnId = turn.codexTurnId;
    return turnId === undefined
      ? Effect.void
      : this.withSession((rpc, threadId) =>
          rpc.request('turn/interrupt', { threadId, turnId }, WireMessage).pipe(
            Effect.asVoid,
            Effect.catchAll((error) => Effect.logWarning('Could not interrupt Codex', error))
          )
        );
  }

  protected handleNotification(method: string, params: WireMessage | undefined): Effect.Effect<void, MalformedMessage> {
    const turn = this.turn;
    if (!CODEX_NOTIFICATIONS.has(method)) {
      return Effect.logDebug(`Skipped Codex notification ${method}`);
    }
    if (!turn) {
      return Effect.void;
    }
    const decode = <A extends { readonly threadId: string }, I>(schema: Schema.Schema<A, I>, handle: (value: A) => Effect.Effect<void>) =>
      Effect.flatMap(decodeMessage(schema, params, `${method} notification`), (value) =>
        // Sub-agents run in threads of their own, whose items belong to a later ticket.
        value.threadId === this.sessionId ? handle(value) : Effect.void
      );
    switch (method) {
      case 'item/agentMessage/delta':
        return decode(Delta, ({ itemId, delta }) => turn.stream('agent_message_chunk', itemId, delta));
      case 'item/reasoning/summaryTextDelta':
        return decode(SummaryDelta, ({ itemId, summaryIndex, delta }) => turn.stream('agent_thought_chunk', `${itemId}:${summaryIndex}`, delta));
      case 'item/started':
        return decode(ItemNews, ({ item }) => this.showToolCall(turn, item, 'started'));
      case 'item/completed':
        return decode(ItemNews, ({ item }) => {
          switch (item.kind) {
            case 'message':
              return turn.complete('agent_message_chunk', item.id, item.text);
            case 'reasoning':
              return Effect.forEach(item.summary, (text, index) => turn.complete('agent_thought_chunk', `${item.id}:${index}`, text), {
                discard: true,
              });
            default:
              return this.showToolCall(turn, item, 'completed');
          }
        });
      case 'error':
        // Codex reports each retry too; only the error that ends the turn is shown.
        return decode(ErrorNotification, ({ error, willRetry }) => (willRetry ? Effect.void : turn.reportError(errorCode(error), errorText(error))));
      case 'turn/completed':
        return decode(TurnCompleted, ({ turn: { status, error } }) => {
          const stopReason = turn.cancelRequested ? 'cancelled' : stopReasonOf(status);
          const report = stopReason === 'error' && error ? turn.reportError(errorCode(error), errorText(error)) : Effect.void;
          return Effect.zipRight(report, this.endTurn(turn, stopReason));
        });
      default:
        return Effect.void;
    }
  }

  /**
   * Codex asks about a command or a file change with a request of its own, which is answered once
   * the user has chosen. The answer is awaited on a fiber of the connection's, so the turn's other
   * traffic keeps flowing while the card waits.
   */
  protected handleRequest(method: string, params: WireMessage | undefined): Effect.Effect<Option.Option<Effect.Effect<WireMessage>>, MalformedMessage> {
    switch (method) {
      case COMMAND_APPROVAL:
        return Effect.map(decodeMessage(CommandApproval, params, `${method} request`), (request) =>
          Option.some(
            this.askApproval(
              {
                toolCallId: request.itemId,
                title: commandApprovalTitle(request),
                kind: request.networkApprovalContext ? 'fetch' : 'execute',
                status: 'pending',
                rawInput: { command: request.command ?? null, cwd: request.cwd ?? null, reason: request.reason ?? null },
              },
              codexApproval(request.availableDecisions)
            )
          )
        );
      case FILE_CHANGE_APPROVAL:
        return Effect.map(decodeMessage(FileChangeApproval, params, `${method} request`), (request) =>
          Option.some(
            this.askApproval(
              {
                toolCallId: request.itemId,
                title: request.grantRoot ? `Write files under ${request.grantRoot}` : 'Apply file changes',
                kind: 'edit',
                status: 'pending',
                rawInput: { reason: request.reason ?? null, grantRoot: request.grantRoot ?? null },
              },
              codexApproval(request.availableDecisions)
            )
          )
        );
      default:
        return Effect.succeedNone;
    }
  }

  /** Asks the user about `toolCall` and answers Codex with the decision behind the option they chose. */
  private askApproval(toolCall: ToolCall, approval: CodexApproval): Effect.Effect<WireMessage> {
    return Effect.suspend(() => {
      const turn = this.turn;
      if (!turn) {
        return Effect.succeed({ decision: CODEX_CANCELLED });
      }
      return Effect.zipRight(
        // The card and the item Codex started are the same tool call, so the ask updates it.
        turn.toolCall(toolCall),
        Effect.map(this.approvals.ask(turn.id, toolCall, approval.options), (outcome) => ({
          decision: (outcome.outcome === 'selected' ? approval.decisions.get(outcome.optionId) : undefined) ?? CODEX_CANCELLED,
        }))
      );
    });
  }

  private showToolCall(turn: CodexTurn, item: ThreadItem, lifecycle: ItemLifecycle): Effect.Effect<void> {
    const toolCall = toolCallOf(item, lifecycle);
    return toolCall ? turn.toolCall(toolCall) : Effect.void;
  }
}

/** What a command approval is about: reaching a host, or running the command Codex wants to run. */
function commandApprovalTitle(request: typeof CommandApproval.Type): string {
  if (request.networkApprovalContext) {
    return `Allow network access to ${request.networkApprovalContext.host}`;
  }
  return request.command ?? 'Run a command';
}

function stopReasonOf(status: string): StopReason {
  switch (status) {
    case 'completed':
      return 'end_turn';
    case 'interrupted':
      return 'cancelled';
    default:
      return 'error';
  }
}

function errorCode(error: typeof TurnFailure.Type): AgentErrorCode {
  return error.codexErrorInfo === 'unauthorized' ? 'not_signed_in' : 'agent_error';
}

function errorText(error: typeof TurnFailure.Type): string {
  const detail = error.additionalDetails ? `${error.message}\n\n${error.additionalDetails}` : error.message;
  return errorCode(error) === 'not_signed_in' ? notSignedInMessage('codex', 'codex login', detail) : detail;
}
