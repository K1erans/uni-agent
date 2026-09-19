import { Option, Schema } from 'effect';
import type { PermissionOption, ToolCallContent, ToolKind } from '../events';
import type { WireMessage } from '../traffic';

/**
 * How Claude Code's tools map onto the normalised event model. Claude names a tool and passes its
 * input as JSON, so the kind comes from the name and the title from whichever input field says
 * what the tool is about.
 */

const TOOL_KINDS = new Map<string, ToolKind>([
  ['Read', 'read'],
  ['NotebookRead', 'read'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['Write', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Bash', 'execute'],
  ['BashOutput', 'execute'],
  ['KillShell', 'execute'],
  ['Glob', 'search'],
  ['Grep', 'search'],
  ['WebFetch', 'fetch'],
  ['WebSearch', 'fetch'],
  ['Task', 'think'],
  ['TodoWrite', 'think'],
]);

/** The input fields that say what a tool call is about, in the order they are preferred for its title. */
const ToolInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const decodeToolInput = Schema.decodeUnknownOption(ToolInput);

/** How a tool call is shown in the thread. */
export interface ToolDescription {
  readonly title: string;
  readonly kind: ToolKind;
}

/**
 * How a tool call is shown: the whole command for `Bash`, otherwise the tool's name and whatever it
 * is about. Claude's own tools are known by name; an MCP tool (`mcp__server__tool`) or one this
 * build does not know is `other`.
 */
export function describeTool(name: string, input: WireMessage): ToolDescription {
  const fields = Option.getOrElse(decodeToolInput(input), (): typeof ToolInput.Type => ({}));
  const subject = fields.file_path ?? fields.path ?? fields.pattern ?? fields.url ?? fields.query ?? fields.description;
  const title = fields.command ?? (subject ? `${name} ${subject}` : name);
  return { title, kind: TOOL_KINDS.get(name) ?? 'other' };
}

const ToolResultBlock = Schema.Union(
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }).pipe(Schema.attachPropertySignature('kind', 'text')),
  Schema.Struct({ type: Schema.String }).pipe(Schema.attachPropertySignature('kind', 'other'))
);

/** What a tool result carries: Claude sends either a string or content blocks. */
export const ToolResultContent = Schema.Union(Schema.String, Schema.Array(ToolResultBlock));
export type ToolResultContent = typeof ToolResultContent.Type;

const isText = Schema.is(Schema.String);

/** A tool result as transcript content; blocks that are not text (images) are left out. */
export function toolResultContent(result: ToolResultContent): ToolCallContent[] {
  const text = isText(result) ? result : result.flatMap((block) => (block.kind === 'text' ? [block.text] : [])).join('\n');
  return text ? [{ type: 'content', content: { type: 'text', text } }] : [];
}

/**
 * What the user can answer a Claude permission request with. "Always" is offered only when Claude
 * suggests permission rules that would stop it asking again; without them it would allow once under
 * a name that promises more.
 */
export function permissionOptions(canAlwaysAllow: boolean): PermissionOption[] {
  return canAlwaysAllow ? [ALLOW_ONCE, ALLOW_ALWAYS, DENY] : [ALLOW_ONCE, DENY];
}

const ALLOW_ONCE: PermissionOption = { optionId: 'allow', name: 'Allow once', kind: 'allow_once' };
const ALLOW_ALWAYS: PermissionOption = { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' };
const DENY: PermissionOption = { optionId: 'deny', name: 'Deny', kind: 'reject_once' };
