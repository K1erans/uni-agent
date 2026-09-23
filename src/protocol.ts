import { Schema } from 'effect';
import { AgentEvent, AgentKind, Mode, ModelInfo } from './agents/events';

/** Messages the sidebar webview posts to the extension. Shared by both bundles. */
export const WebviewMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal('ready') }),
  // Names the thread the webview was showing, so a prompt never lands in a thread switched to since.
  Schema.Struct({ type: Schema.Literal('prompt'), threadId: Schema.String, submissionId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('copy'), text: Schema.String }),
  // The user's answer to a permission request: the ID of the option they chose.
  Schema.Struct({ type: Schema.Literal('permission_response'), threadId: Schema.String, requestId: Schema.String, optionId: Schema.String }),
  // The mode the user picked for a thread. Full auto is only applied once the workspace has opted in.
  Schema.Struct({ type: Schema.Literal('set_mode'), threadId: Schema.String, mode: Mode }),
  Schema.Struct({ type: Schema.Literal('set_agent'), threadId: Schema.String, agent: AgentKind }),
  Schema.Struct({ type: Schema.Literal('set_model'), threadId: Schema.String, agent: AgentKind, model: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('get_models'), threadId: Schema.String, agent: AgentKind })
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

export const PromptRejection = Schema.Literal('busy', 'stale', 'empty', 'unknown', 'read_only');
export type PromptRejection = typeof PromptRejection.Type;

export const ModelDiscoveryFailure = Schema.Struct({ _tag: Schema.Literal('ModelDiscoveryFailed'), message: Schema.String });

/** Messages the extension posts to the sidebar webview. */
export const ExtensionMessage = Schema.Union(
  // The thread to show and everything it has seen so far; replaces the webview's state. Sent on
  // every `ready` and whenever the sidebar switches thread. `readOnly` says why the thread takes
  // no more prompts, if it does not.
  Schema.Struct({
    type: Schema.Literal('history'),
    thread: ThreadInfo,
    mode: Mode,
    model: Schema.NullOr(Schema.String),
    readOnly: Schema.NullOr(Schema.String),
    events: Schema.Array(ThreadEvent),
  }),
  // The thread became read-only, for example because its session could not be resumed.
  Schema.Struct({ type: Schema.Literal('read_only'), threadId: Schema.String, reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal('event'), threadId: Schema.String, ...ThreadEvent.fields }),
  Schema.Union(
    Schema.Struct({ type: Schema.Literal('prompt_result'), threadId: Schema.String, submissionId: Schema.String, status: Schema.Literal('accepted') }),
    Schema.Struct({ type: Schema.Literal('prompt_result'), threadId: Schema.String, submissionId: Schema.String, status: Schema.Literal('rejected'), reason: PromptRejection })
  ),
  // The thread's mode changed.
  Schema.Struct({ type: Schema.Literal('mode'), threadId: Schema.String, mode: Mode }),
  Schema.Struct({ type: Schema.Literal('model'), threadId: Schema.String, model: Schema.NullOr(Schema.String) }),
  Schema.Union(
    Schema.Struct({ type: Schema.Literal('models'), threadId: Schema.String, agent: AgentKind, models: Schema.Array(ModelInfo), error: Schema.Null }),
    Schema.Struct({ type: Schema.Literal('models'), threadId: Schema.String, agent: AgentKind, models: Schema.Array(ModelInfo), error: ModelDiscoveryFailure })
  ),
  // The checked-out branch of the shown thread's workspace; null when unknown or detached.
  Schema.Struct({ type: Schema.Literal('branch'), name: Schema.NullOr(Schema.String) })
);
export type ExtensionMessage = typeof ExtensionMessage.Type;

/** A thread's title: the first line of its first prompt. */
export function threadTitle(prompt: string): string {
  return prompt.trim().split('\n', 1)[0];
}
