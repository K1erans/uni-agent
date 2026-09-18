import type { AgentEvent } from './agents/events';

/** Messages the thread webview posts to the extension. Shared by both bundles. */
export type WebviewMessage = { type: 'ready' } | { type: 'prompt'; text: string };

/** Messages the extension posts to the thread webview. */
export type ExtensionMessage =
  /** Everything the thread has seen so far; replaces the webview's state (sent on every `ready`). */
  | { type: 'history'; events: AgentEvent[] }
  | { type: 'event'; event: AgentEvent };
