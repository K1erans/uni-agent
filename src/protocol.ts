import { Schema } from 'effect';
import { AgentEvent } from './agents/events';

/** Messages the thread webview posts to the extension. Shared by both bundles. */
export const WebviewMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal('ready') }),
  Schema.Struct({ type: Schema.Literal('prompt'), text: Schema.String })
);
export type WebviewMessage = typeof WebviewMessage.Type;

/** Messages the extension posts to the thread webview. */
export const ExtensionMessage = Schema.Union(
  // Everything the thread has seen so far; replaces the webview's state (sent on every `ready`).
  Schema.Struct({ type: Schema.Literal('history'), events: Schema.Array(AgentEvent) }),
  Schema.Struct({ type: Schema.Literal('event'), event: AgentEvent })
);
export type ExtensionMessage = typeof ExtensionMessage.Type;
