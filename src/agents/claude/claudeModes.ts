import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { Schema } from 'effect';
import type { Mode } from '../events';
import { modeOverrides } from '../modes';

/** Claude Code's permission modes, as `uniAgent.claude.modeOverrides` names them. */
export const ClaudePermissionMode = Schema.Literal('default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto') satisfies Schema.Schema<PermissionMode>;

export const ClaudeModeOverrides = modeOverrides(ClaudePermissionMode);

/** How much each permission mode lets Claude do without asking, from least to most. */
const FREEDOM = { plan: 0, dontAsk: 1, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 } satisfies Record<PermissionMode, number>;

/** Whether `override` lets Claude do no more without asking than `builtIn`. */
export function claudeNoLooser(override: PermissionMode, builtIn: PermissionMode): boolean {
  return FREEDOM[override] <= FREEDOM[builtIn];
}

/** Claude has a permission mode for each of the three, so each maps onto its own. */
export function claudePermissionMode(mode: Mode): PermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'auto_edit':
      return 'acceptEdits';
    case 'full_auto':
      return 'bypassPermissions';
  }
}
