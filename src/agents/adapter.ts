import type { AgentEvent, AgentKind, ContentBlock, StopReason } from './events';

/**
 * Drives one native agent session and translates its traffic into {@link AgentEvent}s. A thread
 * owns exactly one adapter for its lifetime. Adapters never throw for agent failures: they emit an
 * `error` event instead, so every failure reaches the thread.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;
  /** The native session ID, known from construction onwards. */
  readonly sessionId: string;

  /** Registers the listener that receives every event; returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;

  /** Announces the session and checks the agent can run. Call once, after subscribing. */
  start(): void;

  /** Runs one prompt turn; resolves when the turn ends. */
  prompt(prompt: ContentBlock[]): Promise<StopReason>;

  /** Asks the agent to stop the running turn, which then ends as `cancelled`. */
  cancel(): Promise<void>;

  /** Stops the agent process. */
  dispose(): void;
}

/** Fan-out for adapter events; adapters extend it rather than re-implementing subscription. */
export class AgentEventEmitter {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
