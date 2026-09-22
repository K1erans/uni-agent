import { Effect, Option, Schema, type Deferred, type Scope } from 'effect';
import { Ids } from '../../ids';
import { ModeChangeFailed, notSignedInMessage, type AdapterOptions } from '../adapter';
import { ContentBlock, MODE_NAMES, PermissionOption, StopReason, ToolCallStatus, ToolKind, type ToolCall, type ToolCallContent } from '../events';
import { Executables } from '../findExecutable';
import { ModeSettings } from '../modes';
import { decodeMessage, type JsonRpcConnection, type MalformedMessage, type RpcError } from '../jsonRpc';
import { AgentFailure, CLIENT_INFO, JsonRpcAdapter, type OpenedSession, type TurnError } from '../jsonRpcAdapter';
import { Stdio } from '../stdio';
import { WireMessage } from '../traffic';
import { Turn, type ChunkKind } from '../turn';
import { CursorModeOverrides, cursorModeId, cursorNoLooser, cursorSessionMode } from './cursorModes';

// The parts of the Agent Client Protocol (https://agentclientprotocol.com) the adapter reads.

const PROTOCOL_VERSION = 1;
/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = -32000;

const Initialized = Schema.Struct({
  agentCapabilities: Schema.optional(Schema.Struct({ loadSession: Schema.optional(Schema.Boolean) })),
});

/** The result of `session/new` and `session/load`: the session's model and mode, when the agent has them. */
const SessionOpened = Schema.Struct({
  configOptions: Schema.optional(Schema.Array(WireMessage)),
  models: Schema.optional(
    Schema.Struct({
      currentModelId: Schema.String,
      availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })),
    })
  ),
  modes: Schema.optional(
    Schema.Struct({ currentModeId: Schema.String, availableModes: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))) })
  ),
});

const ModelConfigOption = Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.String),
  type: Schema.Literal('select'),
  currentValue: Schema.String,
  options: Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })),
});
const decodeModelConfigOption = Schema.decodeUnknownOption(ModelConfigOption);
const ConfigOptionsChanged = Schema.Struct({ configOptions: Schema.Array(WireMessage) });

/** The ACP session mode a session runs in, and the ones it offers. */
interface SessionModes {
  readonly current: string | undefined;
  readonly available: Option.Option<ReadonlyArray<string>>;
}

const SessionCreated = Schema.Struct({ sessionId: Schema.String, ...SessionOpened.fields });

const PromptResult = Schema.Struct({ stopReason: StopReason });

/**
 * A tool call as ACP describes it. Its fields are the normalised model's own, except that content
 * blocks are read loosely: an agent may send kinds (images, terminals) the thread cannot show yet,
 * and one of those must not break the session.
 */
const AcpToolCall = Schema.Struct({
  toolCallId: Schema.String,
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(WireMessage)),
  rawInput: Schema.optional(WireMessage),
  rawOutput: Schema.optional(WireMessage),
});
type AcpToolCall = typeof AcpToolCall.Type;

const SessionUpdate = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Union(
    Schema.Struct({ sessionUpdate: Schema.Literal('agent_message_chunk', 'agent_thought_chunk'), content: ContentBlock }).pipe(
      Schema.attachPropertySignature('variant', 'text')
    ),
    Schema.Struct({ sessionUpdate: Schema.Literal('tool_call'), title: Schema.String, ...AcpToolCall.fields }).pipe(
      Schema.attachPropertySignature('variant', 'toolCall')
    ),
    Schema.Struct({ sessionUpdate: Schema.Literal('tool_call_update'), title: Schema.optional(Schema.String), ...AcpToolCall.fields }).pipe(
      Schema.attachPropertySignature('variant', 'toolCallUpdate')
    ),
    // Plans and the agent's own updates (commands, session titles) arrive with later tickets.
    Schema.Struct({ sessionUpdate: Schema.String }).pipe(Schema.attachPropertySignature('variant', 'other'))
  ),
});

/** What the agent asks permission for: the tool call it is about and the answers it offers. */
const RequestPermission = Schema.Struct({
  sessionId: Schema.String,
  toolCall: Schema.Struct({ title: Schema.optional(Schema.String), ...AcpToolCall.fields }),
  options: Schema.Array(Schema.Struct({ optionId: Schema.String, name: Schema.String, kind: Schema.String })),
});

class CursorTurn extends Turn {
  private lastKind: ChunkKind | undefined;
  private messages = 0;

  /** ACP chunks carry no message ID, so consecutive chunks of one kind make up one message. */
  messageId(kind: ChunkKind): string {
    if (kind !== this.lastKind) {
      this.lastKind = kind;
      this.messages++;
    }
    return `${this.id}:${this.messages}`;
  }
}

/**
 * Drives the user's own Cursor agent CLI through the Agent Client Protocol: JSON-RPC over the stdio
 * of `agent acp`. The normalised event model is shaped after ACP, so session updates pass through
 * nearly as they are. Uni Agent never touches Cursor credentials: the CLI signs in by itself.
 *
 * The client offers no capabilities yet (file system, terminals), and every request the agent
 * sends, including Cursor's extension methods, is declined with "method not found".
 */
export class CursorAdapter extends JsonRpcAdapter<CursorTurn> {
  readonly agent = 'cursor' as const;
  protected readonly command = 'agent';
  protected readonly args = ['acp'];
  /** Set while `session/load` replays the session's history, which the thread has already shown. */
  private loading = false;
  /** The session's mode and the modes it offers; the offer is unknown if the agent did not report it. */
  private sessionMode: SessionModes = { current: undefined, available: Option.none() };

  static make(options: AdapterOptions): Effect.Effect<CursorAdapter, never, Stdio | Executables | Ids | ModeSettings | Scope.Scope> {
    return Effect.gen(function* () {
      const adapter = new CursorAdapter(options, yield* Stdio, yield* Executables, yield* Ids, yield* ModeSettings, yield* Effect.scope);
      yield* adapter.start();
      return adapter;
    });
  }

  protected newTurn(id: string, ended: Deferred.Deferred<StopReason>): CursorTurn {
    return new CursorTurn(id, ended, this.options.onEvent);
  }

  protected openSession(rpc: JsonRpcConnection, resume: Option.Option<string>): Effect.Effect<OpenedSession, TurnError> {
    return Effect.gen(this, function* () {
      const { agentCapabilities } = yield* rpc.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: CLIENT_INFO,
        },
        Initialized
      );
      const session = { cwd: this.options.cwd, mcpServers: [] };
      if (Option.isSome(resume) && agentCapabilities?.loadSession) {
        const sessionId = resume.value;
        this.loading = true;
        const loaded = yield* rpc.request('session/load', { sessionId, ...session }, SessionOpened).pipe(Effect.ensuring(Effect.sync(() => (this.loading = false))));
        return yield* this.inMode(rpc, sessionId, loaded);
      }
      const created = yield* rpc.request('session/new', session, SessionCreated);
      return yield* this.inMode(rpc, created.sessionId, created);
    });
  }

  protected sendPrompt(rpc: JsonRpcConnection, sessionId: string, turn: CursorTurn, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void, TurnError> {
    return this.switchMode(rpc, sessionId).pipe(
      Effect.zipRight(rpc.request('session/prompt', { sessionId, prompt }, PromptResult)),
      Effect.flatMap(({ stopReason }) => this.endTurn(turn, turn.cancelRequested ? 'cancelled' : stopReason))
    );
  }

  /**
   * Switches the open session now. If Cursor refuses, it fails, so the thread keeps showing the mode
   * the session still runs in; the next prompt tries the switch again before it runs.
   */
  protected applyMode(): Effect.Effect<void, ModeChangeFailed> {
    return this.withSession((rpc, sessionId) =>
      Effect.mapError(this.switchMode(rpc, sessionId), (error) => new ModeChangeFailed({ agent: this.agent, mode: this.mode, reason: error._tag === 'ConnectionClosed' ? error.reason : error.message }))
    );
  }

  /** Records the modes a session opened with and switches it to the one wanted, reporting the mode it then runs in. */
  private inMode(rpc: JsonRpcConnection, sessionId: string, session: typeof SessionOpened.Type): Effect.Effect<OpenedSession, TurnError> {
    return Effect.gen(this, function* () {
      const { modes } = session;
      this.sessionMode = {
        current: modes?.currentModeId,
        available: Option.fromNullable(modes?.availableModes?.map((mode) => mode.id)),
      };
      yield* this.switchMode(rpc, sessionId);
      const model = yield* this.selectModel(rpc, sessionId, session);
      return { ...opened(sessionId, session), model, permissionMode: this.sessionMode.current ?? 'default' };
    });
  }

  /** Selects a requested model from the session's live catalog before its first prompt. */
  private selectModel(rpc: JsonRpcConnection, sessionId: string, session: typeof SessionOpened.Type): Effect.Effect<string, TurnError> {
    return Effect.gen(this, function* () {
      const requested = this.options.model;
      if (!requested) {
        return opened(sessionId, session).model;
      }
      const config = session.configOptions?.map((option) => Option.getOrUndefined(decodeModelConfigOption(option))).find((option) => option?.category === 'model' || option?.id === 'model');
      if (config) {
        const chosen = modelChoice(config.options, requested);
        if (!chosen) {
          return yield* new AgentFailure({ code: 'agent_error', message: `Cursor does not offer model "${requested}" in this session.` });
        }
        if (chosen.value === config.currentValue) {
          return chosen.name;
        }
        const changed = yield* rpc.request('session/set_config_option', { sessionId, configId: config.id, value: chosen.value }, ConfigOptionsChanged);
        const selected = changed.configOptions.map((option) => Option.getOrUndefined(decodeModelConfigOption(option))).find((option) => option?.id === config.id);
        if (selected?.currentValue !== chosen.value) {
          return yield* new AgentFailure({ code: 'agent_error', message: `Cursor did not select model "${requested}".` });
        }
        return chosen.name;
      }
      const chosen = modelChoice(session.models?.availableModels.map(({ modelId, name }) => ({ value: modelId, name })) ?? [], requested);
      if (!chosen) {
        return yield* new AgentFailure({ code: 'agent_error', message: `Cursor does not offer model "${requested}" in this session.` });
      }
      if (chosen.value !== session.models?.currentModelId) {
        yield* rpc.request('session/set_model', { sessionId, modelId: chosen.value }, WireMessage);
      }
      return chosen.name;
    });
  }

  /**
   * Puts the session in the ACP mode the current mode maps to. If the agent does not offer it, the
   * session runs in a more restrictive mode instead; if it offers none, the turn fails rather than
   * run with more freedom than the user chose. An agent that does not say which modes it offers is
   * asked for the wanted one, and fails the turn if it refuses.
   */
  private switchMode(rpc: JsonRpcConnection, sessionId: string): Effect.Effect<void, TurnError> {
    return Effect.gen(this, function* () {
      const wanted = yield* this.native(cursorModeId, CursorModeOverrides, cursorNoLooser);
      const { current, available } = this.sessionMode;
      const modeId = Option.match(available, { onNone: () => Option.some(wanted), onSome: (offered) => cursorSessionMode(wanted, offered) });
      if (Option.isNone(modeId)) {
        return yield* new AgentFailure({
          code: 'agent_error',
          message: `Cursor offers no session mode that runs ${MODE_NAMES[this.mode]} (it has no "${wanted}" mode, nor a more restrictive one).`,
        });
      }
      if (modeId.value === current) {
        return;
      }
      if (modeId.value !== wanted) {
        yield* Effect.logWarning(`Cursor has no "${wanted}" mode, so the session runs in the more restrictive "${modeId.value}" mode`);
      }
      yield* rpc.request('session/set_mode', { sessionId, modeId: modeId.value }, WireMessage);
      this.sessionMode = { current: modeId.value, available };
    });
  }

  protected interrupt(): Effect.Effect<void> {
    return this.withSession((rpc, sessionId) => rpc.notify('session/cancel', { sessionId }));
  }

  protected rpcFailure(error: RpcError): AgentFailure {
    return error.code === AUTH_REQUIRED ? new AgentFailure({ code: 'not_signed_in', message: notSignedInMessage('cursor', 'agent login') }) : super.rpcFailure(error);
  }

  protected handleNotification(method: string, params: WireMessage | undefined): Effect.Effect<void, MalformedMessage> {
    if (method !== 'session/update') {
      return Effect.logDebug(`Skipped Cursor notification ${method}`);
    }
    return Effect.flatMap(decodeMessage(SessionUpdate, params, 'session/update notification'), ({ sessionId, update }) => {
      const turn = this.turn;
      if (!turn || this.loading || sessionId !== this.sessionId) {
        return Effect.void;
      }
      switch (update.variant) {
        case 'text':
          return turn.chunk(update.sessionUpdate, turn.messageId(update.sessionUpdate), update.content.text);
        case 'toolCall':
          return turn.toolCall(toolCallOf(update.title, update));
        case 'toolCallUpdate':
          // ACP sends the tool call itself first; an update for one the thread never saw is skipped.
          return turn.hasToolCall(update.toolCallId)
            ? turn.updateToolCall({
                toolCallId: update.toolCallId,
                title: update.title,
                kind: kindOf(update.kind),
                status: statusOf(update.status),
                content: contentOf(update.content),
                rawInput: update.rawInput,
                rawOutput: update.rawOutput,
              })
            : Effect.logDebug(`Skipped a Cursor update for unknown tool call ${update.toolCallId}`);
        case 'other':
          return Effect.logDebug(`Skipped a Cursor ${update.sessionUpdate} update`);
      }
    });
  }

  /**
   * ACP's own way of asking permission: the agent's request waits until the user answers, on a
   * fiber of the connection's so the session's other traffic keeps flowing. A request for another
   * session, or one arriving outside a turn, is answered as cancelled.
   */
  protected handleRequest(method: string, params: WireMessage | undefined): Effect.Effect<Option.Option<Effect.Effect<WireMessage>>, MalformedMessage> {
    if (method !== 'session/request_permission') {
      return Effect.succeedNone;
    }
    return Effect.map(decodeMessage(RequestPermission, params, `${method} request`), ({ sessionId, toolCall, options }) =>
      Option.some(
        Effect.suspend(() => {
          const turn = this.turn;
          const offered = permissionOptions(options);
          if (!turn || sessionId !== this.sessionId || offered.length === 0) {
            return Effect.succeed(CANCELLED);
          }
          const call = toolCallOf(toolCall.title ?? 'Tool call', toolCall);
          const ask = Effect.zipRight(
            turn.toolCall({ ...call, status: 'pending' }),
            Effect.map(this.approvals.ask(turn.id, { ...call, status: 'pending' }, offered), (outcome): WireMessage => ({ outcome: { ...outcome } }))
          );
          if (this.mode !== 'full_auto') {
            return ask;
          }
          // Full auto asks for nothing: Cursor has no mode that stops asking, so its asks are allowed
          // here, once. Always-allow would leave a rule behind that outlives the thread, so a request
          // without allow-once goes to the user instead.
          const allow = offered.find((option) => option.kind === 'allow_once');
          if (!allow) {
            return Effect.zipRight(Effect.logWarning(`Cursor offered no allow-once option for "${call.title}", so Full auto asks the user`), ask);
          }
          return Effect.as(turn.toolCall({ ...call, status: 'in_progress' }), { outcome: { outcome: 'selected', optionId: allow.optionId } });
        })
      )
    );
  }
}

/** ACP's answer for a request nobody can answer any more. */
const CANCELLED: WireMessage = { outcome: { outcome: 'cancelled' } };

const isToolKind = Schema.is(ToolKind);
const isToolCallStatus = Schema.is(ToolCallStatus);
const isPermissionOptionKind = Schema.is(PermissionOption.fields.kind);
const isTextContent = Schema.is(Schema.Struct({ type: Schema.Literal('content'), content: ContentBlock }));
const isDiffContent = Schema.is(
  Schema.Struct({
    type: Schema.Literal('diff'),
    path: Schema.String,
    oldText: Schema.optional(Schema.NullOr(Schema.String)),
    newText: Schema.String,
  })
);

/** A tool call as ACP sent it; a kind or status this build does not know falls back to the model's own default. */
function toolCallOf(title: string, call: AcpToolCall): ToolCall {
  return {
    toolCallId: call.toolCallId,
    title,
    kind: kindOf(call.kind) ?? 'other',
    status: statusOf(call.status) ?? 'pending',
    content: contentOf(call.content),
    rawInput: call.rawInput,
    rawOutput: call.rawOutput,
  };
}

function kindOf(kind: string | undefined): ToolKind | undefined {
  return kind !== undefined && isToolKind(kind) ? kind : undefined;
}

function statusOf(status: string | undefined): ToolCallStatus | undefined {
  return status !== undefined && isToolCallStatus(status) ? status : undefined;
}

/** Tool call content the thread can show; blocks of other kinds (images, terminals) are left out. */
function contentOf(content: ReadonlyArray<WireMessage> | undefined): ToolCallContent[] | undefined {
  return content?.flatMap((block): ToolCallContent[] => {
    if (isTextContent(block)) {
      return [{ type: 'content', content: block.content }];
    }
    if (isDiffContent(block)) {
      return [{ type: 'diff', path: block.path, oldText: block.oldText ?? null, newText: block.newText }];
    }
    return [];
  });
}

/** The answers the card offers; an option of a kind this build does not know is left out. */
function permissionOptions(options: typeof RequestPermission.Type.options): PermissionOption[] {
  return options.flatMap((option) =>
    isPermissionOptionKind(option.kind) ? [{ optionId: option.optionId, name: option.name, kind: option.kind }] : []
  );
}

function opened(sessionId: string, { models, modes }: typeof SessionOpened.Type): OpenedSession {
  const model = models && (models.availableModels.find((available) => available.modelId === models.currentModelId)?.name ?? models.currentModelId);
  return { sessionId, model: model ?? 'default', permissionMode: modes?.currentModeId ?? 'default' };
}

function modelChoice<T extends { readonly value: string; readonly name: string }>(choices: ReadonlyArray<T>, requested: string): T | undefined {
  const normalized = requested.trim().toLowerCase().replaceAll(' ', '-');
  return choices.find((choice) => choice.value.toLowerCase() === normalized) ?? choices.find((choice) => choice.name.toLowerCase().replaceAll(' ', '-') === normalized);
}
