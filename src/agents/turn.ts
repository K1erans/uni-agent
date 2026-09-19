import { Deferred, Effect } from 'effect';
import type { EventSink } from './adapter';
import type { AgentErrorCode, StopReason } from './events';

/**
 * One prompt turn, from `turn_started` to `turn_ended`. Tags the events it emits with its turn ID
 * and settles the waiting `prompt` when it ends. Adapters extend it with their own per-turn state.
 */
export class Turn {
  /** Whether the user asked to stop the turn, so it ends as `cancelled` whatever the agent says. */
  cancelRequested = false;
  private errorReported = false;

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
  chunk(sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', messageId: string, text: string): Effect.Effect<void> {
    return text
      ? this.emit({ type: 'session_update', turnId: this.id, update: { sessionUpdate, messageId, content: { type: 'text', text } } })
      : Effect.void;
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
