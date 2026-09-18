import { describe, expect, it } from 'vitest';
import { findExecutable } from './findExecutable';

describe('findExecutable', () => {
  it('returns the first executable match on PATH', () => {
    const found = findExecutable('claude', {
      env: { PATH: '/usr/bin:/home/me/.local/bin:/opt/bin' },
      platform: 'linux',
      isExecutable: (file) => file === '/home/me/.local/bin/claude' || file === '/opt/bin/claude',
    });
    expect(found).toBe('/home/me/.local/bin/claude');
  });

  it('tries PATHEXT extensions on Windows', () => {
    const found = findExecutable('claude', {
      env: { Path: 'C:\\tools;C:\\npm', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isExecutable: (file) => file === 'C:\\npm\\claude.CMD',
    });
    expect(found).toBe('C:\\npm\\claude.CMD');
  });

  it('uses only the override when one is configured', () => {
    const isExecutable = (file: string) => file === '/usr/bin/claude';
    const env = { PATH: '/usr/bin' };
    expect(findExecutable('claude', { override: '/opt/claude', env, platform: 'linux', isExecutable })).toBeUndefined();
    expect(findExecutable('claude', { override: '/usr/bin/claude', env, platform: 'linux', isExecutable })).toBe('/usr/bin/claude');
  });

  it('returns undefined when nothing matches', () => {
    expect(findExecutable('claude', { env: { PATH: '/usr/bin' }, platform: 'linux', isExecutable: () => false })).toBeUndefined();
  });
});
