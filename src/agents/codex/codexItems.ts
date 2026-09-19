import { Schema } from 'effect';
import type { PermissionOption, ToolCall, ToolCallContent, ToolCallStatus } from '../events';
import { WireMessage } from '../traffic';

/**
 * The thread items Codex streams through a started → delta → completed lifecycle, and how the ones
 * that are tool calls (commands, file changes, MCP tools, web searches) map onto the normalised
 * event model. Items of kinds this build does not show are read as `other` and skipped.
 */

const AgentMessage = Schema.Struct({ type: Schema.Literal('agentMessage'), id: Schema.String, text: Schema.String }).pipe(
  Schema.attachPropertySignature('kind', 'message')
);

const Reasoning = Schema.Struct({ type: Schema.Literal('reasoning'), id: Schema.String, summary: Schema.Array(Schema.String) }).pipe(
  Schema.attachPropertySignature('kind', 'reasoning')
);

const CommandExecution = Schema.Struct({
  type: Schema.Literal('commandExecution'),
  id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.String,
  aggregatedOutput: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
}).pipe(Schema.attachPropertySignature('kind', 'command'));

const FileChange = Schema.Struct({
  type: Schema.Literal('fileChange'),
  id: Schema.String,
  // Codex describes each change as a unified diff rather than the file's text before and after.
  changes: Schema.Array(Schema.Struct({ path: Schema.String, diff: Schema.String })),
  status: Schema.String,
}).pipe(Schema.attachPropertySignature('kind', 'fileChange'));

const McpToolCall = Schema.Struct({
  type: Schema.Literal('mcpToolCall'),
  id: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  status: Schema.String,
  arguments: WireMessage,
  result: Schema.NullOr(WireMessage),
  error: Schema.NullOr(Schema.Struct({ message: Schema.String })),
}).pipe(Schema.attachPropertySignature('kind', 'mcpTool'));

const WebSearch = Schema.Struct({ type: Schema.Literal('webSearch'), id: Schema.String, query: Schema.String }).pipe(
  Schema.attachPropertySignature('kind', 'webSearch')
);

export const ThreadItem = Schema.Union(
  AgentMessage,
  Reasoning,
  CommandExecution,
  FileChange,
  McpToolCall,
  WebSearch,
  Schema.Struct({ type: Schema.String }).pipe(Schema.attachPropertySignature('kind', 'other'))
);
export type ThreadItem = typeof ThreadItem.Type;

/** Codex's own statuses for the items that are tool calls; an unknown one counts as still running. */
function statusOf(status: string): ToolCallStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'declined':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function text(value: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text: value } };
}

/** Where in an item's lifecycle the news about it came from, for items that carry no status of their own. */
export type ItemLifecycle = 'started' | 'completed';

/** The tool call an item shows, or undefined for an item that is not one. */
export function toolCallOf(item: ThreadItem, lifecycle: ItemLifecycle): ToolCall | undefined {
  switch (item.kind) {
    case 'command':
      return {
        toolCallId: item.id,
        title: item.command,
        kind: 'execute',
        status: statusOf(item.status),
        content: item.aggregatedOutput ? [text(item.aggregatedOutput)] : undefined,
        rawInput: { command: item.command, cwd: item.cwd },
        rawOutput: item.exitCode === null ? undefined : { exitCode: item.exitCode },
      };
    case 'fileChange':
      return {
        toolCallId: item.id,
        title: fileChangeTitle(item.changes.map((change) => change.path)),
        kind: 'edit',
        status: statusOf(item.status),
        content: item.changes.map((change) => text(change.diff)),
        rawInput: { paths: item.changes.map((change) => change.path) },
      };
    case 'mcpTool':
      return {
        toolCallId: item.id,
        title: `${item.server}: ${item.tool}`,
        kind: 'other',
        status: statusOf(item.status),
        content: item.error ? [text(item.error.message)] : undefined,
        rawInput: item.arguments,
        rawOutput: item.result ?? undefined,
      };
    case 'webSearch':
      // A web search carries no status of its own: it is running until Codex says it is done.
      return {
        toolCallId: item.id,
        title: `Search the web: ${item.query}`,
        kind: 'fetch',
        status: lifecycle === 'started' ? 'in_progress' : 'completed',
        rawInput: { query: item.query },
      };
    default:
      return undefined;
  }
}

function fileChangeTitle(paths: ReadonlyArray<string>): string {
  return paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`;
}

/** What the user can answer a Codex approval request with; the option IDs are Codex's own decisions. */
export const CODEX_APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
];

/** The decision Codex is sent when nobody answers, because the turn was stopped or the thread closed. */
export const CODEX_CANCELLED = 'cancel';
