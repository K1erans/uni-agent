import { Schema } from 'effect';
import { AgentEvent, AgentKind } from './agents/events';

/** Messages the sidebar webview posts to the extension. Shared by both bundles. */
export const WebviewMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal('ready') }),
  // Names the thread the webview was showing, so a prompt never lands in a thread switched to since.
  Schema.Struct({ type: Schema.Literal('prompt'), threadId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('copy'), text: Schema.String }),
  // The user's answer to a permission request: the ID of the option they chose.
  Schema.Struct({ type: Schema.Literal('permission_response'), threadId: Schema.String, requestId: Schema.String, optionId: Schema.String })
);
export type WebviewMessage = typeof WebviewMessage.Type;

/** An agent event and when the thread received it, in milliseconds since the epoch. */
export const ThreadEvent = Schema.Struct({ event: AgentEvent, at: Schema.Number });
export type ThreadEvent = typeof ThreadEvent.Type;

export const ThreadInfo = Schema.Struct({
  id: Schema.String,
  /** The agent the thread talks to, fixed for its lifetime. */
  agent: AgentKind,
  /** Name of the workspace folder the agent runs in; null when no folder is open. */
  workspace: Schema.NullOr(Schema.String),
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** Messages the extension posts to the sidebar webview. */
export const ExtensionMessage = Schema.Union(
  // The thread to show and everything it has seen so far; replaces the webview's state. Sent on
  // every `ready` and whenever the sidebar switches thread.
  Schema.Struct({ type: Schema.Literal('history'), thread: ThreadInfo, events: Schema.Array(ThreadEvent) }),
  Schema.Struct({ type: Schema.Literal('event'), threadId: Schema.String, ...ThreadEvent.fields }),
  // The checked-out branch of the shown thread's workspace; null when unknown or detached.
  Schema.Struct({ type: Schema.Literal('branch'), name: Schema.NullOr(Schema.String) })
);
export type ExtensionMessage = typeof ExtensionMessage.Type;

/** A thread's title: the first line of its first prompt. */
export function threadTitle(prompt: string): string {
  return prompt.trim().split('\n', 1)[0];
}
