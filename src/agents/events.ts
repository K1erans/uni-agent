/**
 * The normalised event model every agent adapter translates into. It is shaped after the Agent
 * Client Protocol (ACP): a session runs prompt turns, and during a turn the agent streams session
 * updates (message chunks, tool calls, plans) and may ask for permission.
 *
 * Unlike ACP, chunks carry a `messageId` so a UI or store can group them into items. Shared by the
 * extension and the webview bundle, so this module must stay free of runtime imports.
 */

export type AgentKind = 'claude' | 'codex' | 'cursor';

export type ContentBlock = { type: 'text'; text: string };

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A file change a tool call made or proposes. `oldText` is null for a new file. */
export interface Diff {
  path: string;
  oldText: string | null;
  newText: string;
}

export type ToolCallContent = { type: 'content'; content: ContentBlock } | ({ type: 'diff' } & Diff);

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; messageId: string; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update'; toolCallId: string } & Partial<Omit<ToolCall, 'toolCallId'>>)
  /** Replaces the whole plan; entries not present are dropped. */
  | { sessionUpdate: 'plan'; entries: PlanEntry[] };

/** Why a turn ended. `error` means an {@link AgentError} event explains it. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';

export type AgentErrorCode =
  /** The agent's CLI could not be found or launched. */
  | 'binary_missing'
  /** The agent's CLI is not signed in; the user must sign in with the CLI itself. */
  | 'not_signed_in'
  /** The agent process exited or broke its protocol unexpectedly. */
  | 'process_crashed'
  /** The agent reported an error of its own (API error, rate limit, ...). */
  | 'agent_error';

export type AgentEvent =
  /** The native session exists (or is reserved) and can be resumed by `sessionId`. */
  | { type: 'session_started'; agent: AgentKind; sessionId: string }
  | { type: 'turn_started'; turnId: string; prompt: ContentBlock[] }
  | { type: 'session_update'; turnId: string; update: SessionUpdate }
  | { type: 'permission_request'; turnId: string; requestId: string; toolCall: ToolCall; options: PermissionOption[] }
  | { type: 'turn_ended'; turnId: string; stopReason: StopReason }
  | { type: 'error'; turnId?: string; code: AgentErrorCode; message: string };

export type AgentError = Extract<AgentEvent, { type: 'error' }>;
