import type { AgentErrorCode, ToolCallStatus } from '../../src/agents/events';
import type { AgentStatus } from './threadState';

export { AGENT_NAMES } from '../../src/agents/events';

export const STATUS_LABELS = {
  ready: 'Ready',
  working: 'Working',
  needs_approval: 'Needs approval',
  not_found: 'Not found',
  not_signed_in: 'Not signed in',
  stopped: 'Stopped',
} satisfies Record<AgentStatus, string>;

export const ERROR_TITLES = {
  binary_missing: 'The agent couldn’t start',
  not_signed_in: 'Not signed in',
  process_crashed: 'The agent stopped unexpectedly',
  agent_error: 'The response couldn’t finish',
} satisfies Record<AgentErrorCode, string>;

/** Claude Code's permission modes; any other agent or mode is shown as the agent names it. */
const PERMISSION_MODES = new Map([
  ['default', 'Default'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan mode'],
  ['bypassPermissions', 'Full access'],
  ['dontAsk', 'Don’t ask'],
]);

export function permissionLabel(mode: string): string {
  return PERMISSION_MODES.get(mode) ?? mode;
}

/** What a tool call's status says it is doing, for the badge on its header. */
export const TOOL_STATUS_LABELS = {
  pending: 'Waiting',
  in_progress: 'Running',
  completed: 'Done',
  failed: 'Failed',
} satisfies Record<ToolCallStatus, string>;

/** A compact duration: `42s`, `3m 5s`, `1h 2m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
