import { Data, type Effect, type Scope } from 'effect';
import type { AgentEvent, AgentKind, ContentBlock, StopReason } from './events';

/**
 * Drives one native agent session and translates its traffic into {@link AgentEvent}s. A thread
 * owns exactly one adapter for its lifetime. Adapters never fail for agent failures: they emit an
 * `error` event instead, so every failure reaches the thread.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;
  /** The native session ID, known from construction onwards. */
  readonly sessionId: string;

  /** Runs one prompt turn; succeeds with why the turn ended. */
  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason, TurnInProgress>;

  /** Asks the agent to stop the running turn, which then ends as `cancelled`. */
  cancel(): Effect.Effect<void>;
}

/** Receives every event an adapter emits, in order. */
export type EventSink = (event: AgentEvent) => Effect.Effect<void>;

/**
 * Builds an adapter for a new session. Before returning, the adapter announces the session through
 * the sink and checks the agent can run. Closing the scope stops the agent process and ends a
 * running turn as `cancelled`.
 */
export type MakeAdapter<R> = (onEvent: EventSink) => Effect.Effect<AgentAdapter, never, R | Scope.Scope>;

/** A prompt arrived while the session was still running a turn. */
export class TurnInProgress extends Data.TaggedError('TurnInProgress')<{ readonly sessionId: string }> {}
