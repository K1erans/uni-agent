import { Deferred, Effect } from 'effect';
import type { EventSink } from './adapter';
import type { AgentErrorCode, StopReason, ToolCall, ToolCallUpdate } from './events';

/** The session updates that stream a piece of the agent's reply or thinking. */
export type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk';

/**
 * One prompt turn, from `turn_started` to `turn_ended`. Tags the events it emits with its turn ID
 * and settles the waiting `prompt` when it ends. Adapters extend it with their own per-turn state.
 */
export class Turn {
  /** Whether the user asked to stop the turn, so it ends as `cancelled` whatever the agent says. */
  cancelRequested = false;
  private errorReported = false;
  /** The tool calls shown so far, so later news about one is sent as an update to it. */
  private readonly toolCalls = new Set<string>();

  constructor(
    readonly id: string,
    private readonly ended: Deferred.Deferred<StopReason>,
    private readonly emit: EventSink
  ) {}

  /** Waits for the turn to end; succeeds with why it ended. */
  awaitEnd(): Effect.Effect<StopReason> {
    return Deferred.await(this.ended);
  }

  /** Streams a piece of the agent's reply or thinking; empty text is dropped. */
  chunk(sessionUpdate: ChunkKind, messageId: string, text: string): Effect.Effect<void> {
    return text
      ? this.emit({ type: 'session_update', turnId: this.id, update: { sessionUpdate, messageId, content: { type: 'text', text } } })
      : Effect.void;
  }

  /** Whether this tool call has been shown, and so what the agent says about it next is an update. */
  hasToolCall(toolCallId: string): boolean {
    return this.toolCalls.has(toolCallId);
  }

  /** Shows a tool call the agent started, or one it is asking permission for; one shown already is updated. */
  toolCall(call: ToolCall): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.toolCalls.has(call.toolCallId)) {
        return this.updateToolCall(call);
      }
      this.toolCalls.add(call.toolCallId);
      return this.emit({ type: 'session_update', turnId: this.id, update: { sessionUpdate: 'tool_call', ...call } });
    });
  }

  /** Changes a tool call already shown; fields left out keep the value they had. */
  updateToolCall(update: ToolCallUpdate): Effect.Effect<void> {
    return this.emit({ type: 'session_update', turnId: this.id, update: { sessionUpdate: 'tool_call_update', ...update } });
  }

  /** Reports the turn's first error; later ones are usually the same failure echoed again. */
  reportError(code: AgentErrorCode, message: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.errorReported) {
        return Effect.void;
      }
      this.errorReported = true;
      return this.emit({ type: 'error', turnId: this.id, code, message });
    });
  }

  end(stopReason: StopReason): Effect.Effect<void> {
    return Effect.zipRight(this.emit({ type: 'turn_ended', turnId: this.id, stopReason }), Deferred.succeed(this.ended, stopReason));
  }
}
