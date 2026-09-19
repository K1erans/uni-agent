import { Effect, Option, Schema, type Deferred, type Scope } from 'effect';
import { Ids } from '../../ids';
import { notSignedInMessage, type AdapterOptions } from '../adapter';
import { ContentBlock, StopReason } from '../events';
import { Executables } from '../findExecutable';
import { decodeMessage, type JsonRpcConnection, type MalformedMessage, type RpcError } from '../jsonRpc';
import { AgentFailure, CLIENT_INFO, JsonRpcAdapter, type OpenedSession, type TurnError } from '../jsonRpcAdapter';
import { Stdio } from '../stdio';
import type { WireMessage } from '../traffic';
import { Turn, type ChunkKind } from '../turn';

// The parts of the Agent Client Protocol (https://agentclientprotocol.com) the adapter reads.

const PROTOCOL_VERSION = 1;
/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = -32000;

const Initialized = Schema.Struct({
  agentCapabilities: Schema.optional(Schema.Struct({ loadSession: Schema.optional(Schema.Boolean) })),
});

/** The result of `session/new` and `session/load`: the session's model and mode, when the agent has them. */
const SessionOpened = Schema.Struct({
  models: Schema.optional(
    Schema.Struct({
      currentModelId: Schema.String,
      availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })),
    })
  ),
  modes: Schema.optional(Schema.Struct({ currentModeId: Schema.String })),
});

const SessionCreated = Schema.Struct({ sessionId: Schema.String, ...SessionOpened.fields });

const PromptResult = Schema.Struct({ stopReason: StopReason });

const SessionUpdate = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Union(
    Schema.Struct({ sessionUpdate: Schema.Literal('agent_message_chunk', 'agent_thought_chunk'), content: ContentBlock }).pipe(
      Schema.attachPropertySignature('kind', 'text')
    ),
    // Tool calls, plans, non-text content and the agent's own updates (commands, titles) arrive
    // with later tickets.
    Schema.Struct({ sessionUpdate: Schema.String }).pipe(Schema.attachPropertySignature('kind', 'other'))
  ),
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

  static make(options: AdapterOptions): Effect.Effect<CursorAdapter, never, Stdio | Executables | Ids | Scope.Scope> {
    return Effect.gen(function* () {
      const adapter = new CursorAdapter(options, yield* Stdio, yield* Executables, yield* Ids, yield* Effect.scope);
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
        return opened(sessionId, loaded);
      }
      const created = yield* rpc.request('session/new', session, SessionCreated);
      return opened(created.sessionId, created);
    });
  }

  protected sendPrompt(rpc: JsonRpcConnection, sessionId: string, turn: CursorTurn, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void, TurnError> {
    return Effect.flatMap(rpc.request('session/prompt', { sessionId, prompt }, PromptResult), ({ stopReason }) =>
      this.endTurn(turn, turn.cancelRequested ? 'cancelled' : stopReason)
    );
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
      if (update.kind === 'other') {
        return Effect.logDebug(`Skipped a Cursor ${update.sessionUpdate} update`);
      }
      return turn.chunk(update.sessionUpdate, turn.messageId(update.sessionUpdate), update.content.text);
    });
  }
}

function opened(sessionId: string, { models, modes }: typeof SessionOpened.Type): OpenedSession {
  const model = models && (models.availableModels.find((available) => available.modelId === models.currentModelId)?.name ?? models.currentModelId);
  return { sessionId, model: model ?? 'default', permissionMode: modes?.currentModeId ?? 'default' };
}
