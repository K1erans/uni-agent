import { Schema } from 'effect';

/**
 * The normalised event model every agent adapter translates into. It is shaped after the Agent
 * Client Protocol (ACP): a session runs prompt turns, and during a turn the agent streams session
 * updates (message chunks, tool calls, plans) and may ask for permission.
 *
 * Unlike ACP, chunks carry a `messageId` so a UI or store can group them into items. Shared by the
 * extension and the webview bundle. Each type is defined by its schema, so either side can decode
 * events that cross the webview boundary.
 */

export const AgentKind = Schema.Literal('claude', 'codex', 'cursor');
export type AgentKind = typeof AgentKind.Type;

/** A model offered by the selected agent, with its native ID and picker label. */
export const ModelInfo = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString });
export type ModelInfo = typeof ModelInfo.Type;

export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' } satisfies Record<AgentKind, string>;

/**
 * How freely a thread's agent may act, the same three choices for every agent. Each adapter maps
 * the mode onto the agent's own permission settings.
 * - `plan`: read-only investigation.
 * - `auto_edit`: applies edits freely, but asks before running commands.
 * - `full_auto`: asks for nothing. Only selectable once the user has opted in for the workspace.
 */
export const Mode = Schema.Literal('plan', 'auto_edit', 'full_auto');
export type Mode = typeof Mode.Type;

/** The mode a new thread starts in. */
export const DEFAULT_MODE: Mode = 'auto_edit';

export const MODE_NAMES = { plan: 'Plan', auto_edit: 'Auto-edit', full_auto: 'Full auto' } satisfies Record<Mode, string>;

export const ContentBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String });
export type ContentBlock = typeof ContentBlock.Type;

export const ToolKind = Schema.Literal('read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other');
export type ToolKind = typeof ToolKind.Type;

export const ToolCallStatus = Schema.Literal('pending', 'in_progress', 'completed', 'failed');
export type ToolCallStatus = typeof ToolCallStatus.Type;

const diffFields = { path: Schema.String, oldText: Schema.NullOr(Schema.String), newText: Schema.String };

/** A file change a tool call made or proposes. `oldText` is null for a new file. */
export const Diff = Schema.Struct(diffFields);
export type Diff = typeof Diff.Type;

export const ToolCallContent = Schema.Union(
  Schema.Struct({ type: Schema.Literal('content'), content: ContentBlock }),
  Schema.Struct({ type: Schema.Literal('diff'), ...diffFields })
);
export type ToolCallContent = typeof ToolCallContent.Type;

const toolCallFields = {
  toolCallId: Schema.String,
  title: Schema.String,
  kind: ToolKind,
  status: ToolCallStatus,
  content: Schema.optional(Schema.Array(ToolCallContent)),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
};

export const ToolCall = Schema.Struct(toolCallFields);
export type ToolCall = typeof ToolCall.Type;

const toolCallUpdateFields = {
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(ToolKind),
  status: Schema.optional(ToolCallStatus),
  content: toolCallFields.content,
  rawInput: toolCallFields.rawInput,
  rawOutput: toolCallFields.rawOutput,
};

/** What changed about a tool call already shown; fields left out keep the value they had. */
export const ToolCallUpdate = Schema.Struct(toolCallUpdateFields);
export type ToolCallUpdate = typeof ToolCallUpdate.Type;

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literal('high', 'medium', 'low'),
  status: Schema.Literal('pending', 'in_progress', 'completed'),
});
export type PlanEntry = typeof PlanEntry.Type;

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('allow_once', 'allow_always', 'reject_once', 'reject_always'),
});
export type PermissionOption = typeof PermissionOption.Type;

/** How a permission request was answered: with one of its options, or cancelled with its turn. */
export const PermissionOutcome = Schema.Union(
  Schema.Struct({ outcome: Schema.Literal('selected'), optionId: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal('cancelled') })
);
export type PermissionOutcome = typeof PermissionOutcome.Type;

export const SessionUpdate = Schema.Union(
  Schema.Struct({ sessionUpdate: Schema.Literal('agent_message_chunk'), messageId: Schema.String, content: ContentBlock }),
  Schema.Struct({ sessionUpdate: Schema.Literal('agent_thought_chunk'), messageId: Schema.String, content: ContentBlock }),
  Schema.Struct({ sessionUpdate: Schema.Literal('tool_call'), ...toolCallFields }),
  Schema.Struct({ sessionUpdate: Schema.Literal('tool_call_update'), ...toolCallUpdateFields }),
  // Replaces the whole plan; entries not present are dropped.
  Schema.Struct({ sessionUpdate: Schema.Literal('plan'), entries: Schema.Array(PlanEntry) })
);
export type SessionUpdate = typeof SessionUpdate.Type;

/** Why a turn ended. `error` means an {@link AgentError} event explains it. */
export const StopReason = Schema.Literal('end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error');
export type StopReason = typeof StopReason.Type;

/**
 * - `binary_missing`: the agent's CLI could not be found or launched.
 * - `not_signed_in`: the agent's CLI is not signed in; the user must sign in with the CLI itself.
 * - `process_crashed`: the agent process exited or broke its protocol unexpectedly.
 * - `agent_error`: the agent reported an error of its own (API error, rate limit, ...).
 */
export const AgentErrorCode = Schema.Literal('binary_missing', 'not_signed_in', 'process_crashed', 'agent_error');
export type AgentErrorCode = typeof AgentErrorCode.Type;

export const AgentEvent = Schema.Union(
  // The native session exists (or is reserved) and can be resumed by `sessionId`. Agents that take
  // the ID from the client (Claude) announce it up front; agents that assign their own (Codex,
  // Cursor) announce it once the first turn has created the session.
  Schema.Struct({ type: Schema.Literal('session_started'), agent: AgentKind, sessionId: Schema.String }),
  // The model and permission mode the agent runs the session with, as it reports them. Sent again
  // whenever the agent (re)starts, so the latest one is current. Modes are the agent's own names.
  Schema.Struct({ type: Schema.Literal('session_configured'), model: Schema.String, permissionMode: Schema.String }),
  Schema.Struct({ type: Schema.Literal('turn_started'), turnId: Schema.String, prompt: Schema.Array(ContentBlock) }),
  Schema.Struct({ type: Schema.Literal('session_update'), turnId: Schema.String, update: SessionUpdate }),
  Schema.Struct({
    type: Schema.Literal('permission_request'),
    turnId: Schema.String,
    requestId: Schema.String,
    toolCall: ToolCall,
    options: Schema.Array(PermissionOption),
  }),
  // Every permission request is resolved exactly once, at the latest before its turn ends.
  Schema.Struct({ type: Schema.Literal('permission_resolved'), turnId: Schema.String, requestId: Schema.String, outcome: PermissionOutcome }),
  Schema.Struct({ type: Schema.Literal('turn_ended'), turnId: Schema.String, stopReason: StopReason }),
  Schema.Struct({
    type: Schema.Literal('error'),
    turnId: Schema.optional(Schema.String),
    code: AgentErrorCode,
    message: Schema.String,
  })
);
export type AgentEvent = typeof AgentEvent.Type;

export type AgentError = Extract<AgentEvent, { type: 'error' }>;
