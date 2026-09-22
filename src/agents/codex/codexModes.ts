import { Schema } from 'effect';
import type { Mode } from '../events';
import { modeOverrides } from '../modes';
import type { WireMessage } from '../traffic';

/** Codex's named approval policies (its granular policy is not offered). */
export const CodexApprovalPolicy = Schema.Literal('untrusted', 'on-request', 'never');

/** Codex's sandbox modes, as `thread/start` and the Codex CLI name them. */
export const CodexSandboxMode = Schema.Literal('read-only', 'workspace-write', 'danger-full-access');
export type CodexSandboxMode = typeof CodexSandboxMode.Type;

/** What Codex runs a turn with: when it asks, and what it may touch without asking. */
export const CodexPolicy = Schema.Struct({ approvalPolicy: CodexApprovalPolicy, sandbox: CodexSandboxMode });
export type CodexPolicy = typeof CodexPolicy.Type;

export const CodexModeOverrides = modeOverrides(CodexPolicy);

/**
 * Codex has no setting that applies edits freely but asks before every command: `on-request` runs
 * commands in the sandbox without asking. So Auto-edit falls back to the more restrictive
 * `untrusted`, which asks before edits and commands alike.
 */
export function codexPolicy(mode: Mode): CodexPolicy {
  switch (mode) {
    // Nothing escapes the read-only sandbox, and Codex never asks to.
    case 'plan':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'auto_edit':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'full_auto':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

/** A sandbox mode in the form `turn/start` takes it. The working directory is always writable, so no other roots are added. */
export function sandboxPolicy(sandbox: CodexSandboxMode): WireMessage {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}
