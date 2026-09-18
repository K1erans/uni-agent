import type { AgentAdapter } from './agents/adapter';
import type { AgentEvent } from './agents/events';
import type { ExtensionMessage, WebviewMessage } from './protocol';

/**
 * One conversation with one agent. Keeps every event the adapter emits so a webview that (re)loads
 * — a hidden tab coming back, a reload — is brought up to date by replaying them.
 */
export class Thread {
  private readonly history: AgentEvent[] = [];
  private post: ((message: ExtensionMessage) => void) | undefined;
  private running = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly adapter: AgentAdapter) {
    this.unsubscribe = adapter.onEvent((event) => {
      if (event.type === 'turn_started' || event.type === 'turn_ended') {
        this.running = event.type === 'turn_started';
      }
      this.history.push(event);
      this.post?.({ type: 'event', event });
    });
    adapter.start();
  }

  /** Connects a freshly loaded webview, replacing any previous one. */
  attach(post: (message: ExtensionMessage) => void): void {
    this.post = post;
    post({ type: 'history', events: [...this.history] });
  }

  handle(message: WebviewMessage): void {
    if (message.type === 'prompt' && message.text.trim() && !this.running) {
      void this.adapter.prompt([{ type: 'text', text: message.text }]);
    }
  }

  dispose(): void {
    this.post = undefined;
    this.unsubscribe();
    this.adapter.dispose();
  }
}
