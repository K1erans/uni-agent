import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { ClaudeModeOverrides, claudePermissionMode } from './claude/claudeModes';
import { CodexModeOverrides, codexPolicy, sandboxPolicy } from './codex/codexModes';
import { CursorModeOverrides, cursorModeId, cursorSessionMode } from './cursor/cursorModes';
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

describe('Mode overrides', () => {
  it('uses the override for a mode that names one, and the built-in mapping for the rest', () => {
    const overrides = Option.some({ auto_edit: 'default' as const });

    expect(nativeMode('auto_edit', claudePermissionMode, overrides)).toBe('default');
    expect(nativeMode('plan', claudePermissionMode, overrides)).toBe('plan');
    expect(nativeMode('full_auto', claudePermissionMode, Option.none())).toBe('bypassPermissions');
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
