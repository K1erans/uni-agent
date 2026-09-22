import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { ClaudeModeOverrides, claudeNoLooser, claudePermissionMode } from './claude/claudeModes';
import { CodexModeOverrides, codexNoLooser, codexPolicy, sandboxPolicy } from './codex/codexModes';
import { CursorModeOverrides, cursorModeId, cursorNoLooser, cursorSessionMode } from './cursor/cursorModes';
import { nativeMode } from './modes';
import type { WireMessage } from './traffic';

describe('Claude mode mapping', () => {
  it.each([
    ['plan', 'plan'],
    ['auto_edit', 'acceptEdits'],
    ['full_auto', 'bypassPermissions'],
  ] as const)('runs %s in the %s permission mode', (mode, native) => {
    expect(claudePermissionMode(mode)).toBe(native);
  });
});

describe('Claude override limits', () => {
  it('allows only permission modes that let Claude do no more without asking', () => {
    expect(claudeNoLooser('default', 'acceptEdits')).toBe(true);
    expect(claudeNoLooser('dontAsk', 'plan')).toBe(false);
    expect(claudeNoLooser('auto', 'acceptEdits')).toBe(false);
    expect(claudeNoLooser('bypassPermissions', 'plan')).toBe(false);
    expect(claudeNoLooser('bypassPermissions', 'bypassPermissions')).toBe(true);
  });
});

describe('Codex mode mapping', () => {
  it.each([
    ['plan', { approvalPolicy: 'never', sandbox: 'read-only' }],
    // Codex cannot apply edits freely yet ask before every command, so it asks before both.
    ['auto_edit', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
    ['full_auto', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
  ] as const)('runs %s with %o', (mode, native) => {
    expect(codexPolicy(mode)).toEqual(native);
  });

  it('sends each sandbox mode in the shape turn/start takes', () => {
    expect(sandboxPolicy('read-only')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(sandboxPolicy('workspace-write')).toMatchObject({ type: 'workspaceWrite', writableRoots: [], networkAccess: false });
    expect(sandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' });
  });
});

describe('Codex override limits', () => {
  it('allows only policies that ask no less and touch no more', () => {
    const plan = codexPolicy('plan');
    const autoEdit = codexPolicy('auto_edit');

    expect(codexNoLooser({ approvalPolicy: 'on-request', sandbox: 'read-only' }, plan)).toBe(true);
    expect(codexNoLooser({ approvalPolicy: 'never', sandbox: 'danger-full-access' }, plan)).toBe(false);
    // Asks less than untrusted, though in the same sandbox.
    expect(codexNoLooser({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }, autoEdit)).toBe(false);
    expect(codexNoLooser({ approvalPolicy: 'untrusted', sandbox: 'read-only' }, autoEdit)).toBe(true);
  });
});

describe('Cursor mode mapping', () => {
  it.each([
    ['plan', 'plan'],
    ['auto_edit', 'agent'],
    // Cursor has no mode that stops asking; the adapter allows its asks itself.
    ['full_auto', 'agent'],
  ] as const)('runs %s in the %s session mode', (mode, native) => {
    expect(cursorModeId(mode)).toBe(native);
  });

  it('runs the wanted session mode when the agent offers it', () => {
    expect(cursorSessionMode('plan', ['agent', 'plan', 'ask'])).toEqual(Option.some('plan'));
  });

  it('falls back to the nearest more restrictive mode the agent offers', () => {
    expect(cursorSessionMode('agent', ['plan', 'ask'])).toEqual(Option.some('plan'));
    expect(cursorSessionMode('plan', ['agent', 'ask'])).toEqual(Option.some('ask'));
  });

  it('never falls back to a less restrictive mode', () => {
    expect(cursorSessionMode('plan', ['agent'])).toEqual(Option.none());
    expect(cursorSessionMode('ask', ['agent', 'plan'])).toEqual(Option.none());
  });

  it('runs a mode it does not know in the most restrictive mode offered', () => {
    expect(cursorSessionMode('yolo', ['agent', 'plan', 'ask'])).toEqual(Option.some('ask'));
    expect(cursorSessionMode('yolo', ['agent'])).toEqual(Option.some('agent'));
    expect(cursorSessionMode('yolo', ['debug'])).toEqual(Option.none());
  });
});

/** Decodes a raw `modeOverrides` setting as `readSetting` does. */
const decode = <A, I>(schema: Schema.Schema<A, I>, value: WireMessage) => Schema.decodeUnknownOption(schema)(value);

describe('Cursor override limits', () => {
  it('allows only known session modes no less restrictive than the built-in one', () => {
    expect(cursorNoLooser('ask', 'plan')).toBe(true);
    expect(cursorNoLooser('plan', 'agent')).toBe(true);
    expect(cursorNoLooser('agent', 'plan')).toBe(false);
    expect(cursorNoLooser('yolo', 'agent')).toBe(false);
  });
});

describe('Mode overrides', () => {
  it('uses the override for a mode that names one, and the built-in mapping for the rest', () => {
    const overrides = Option.some({ auto_edit: 'default' as const });

    expect(nativeMode('auto_edit', claudePermissionMode, overrides, claudeNoLooser)).toEqual({ native: 'default', ignored: Option.none() });
    expect(nativeMode('plan', claudePermissionMode, overrides, claudeNoLooser)).toEqual({ native: 'plan', ignored: Option.none() });
    expect(nativeMode('full_auto', claudePermissionMode, Option.none(), claudeNoLooser)).toEqual({ native: 'bypassPermissions', ignored: Option.none() });
  });

  it('ignores an override that would give a mode more freedom than its built-in setting', () => {
    const overrides = Option.some({ plan: 'bypassPermissions' as const });

    expect(nativeMode('plan', claudePermissionMode, overrides, claudeNoLooser)).toEqual({ native: 'plan', ignored: Option.some('bypassPermissions') });
  });

  it('accepts each agent’s own native values', () => {
    expect(decode(ClaudeModeOverrides, { auto_edit: 'default' })).toEqual(Option.some({ auto_edit: 'default' }));
    expect(decode(CodexModeOverrides, { plan: { approvalPolicy: 'on-request', sandbox: 'read-only' } })).toEqual(
      Option.some({ plan: { approvalPolicy: 'on-request', sandbox: 'read-only' } })
    );
    expect(decode(CursorModeOverrides, { plan: 'ask' })).toEqual(Option.some({ plan: 'ask' }));
  });

  it('rejects an invalid override as a whole, so the built-in mapping applies', () => {
    expect(decode(ClaudeModeOverrides, { plan: 'plan', auto_edit: 'yolo' })).toEqual(Option.none());
    expect(decode(CodexModeOverrides, { full_auto: { approvalPolicy: 'never' } })).toEqual(Option.none());
    expect(decode(CursorModeOverrides, { plan: '' })).toEqual(Option.none());
    expect(decode(ClaudeModeOverrides, 'bypassPermissions')).toEqual(Option.none());
  });
});
