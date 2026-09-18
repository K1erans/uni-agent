import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { nodeSqliteAvailable } from './nodeSqlite';

describe('nodeSqliteAvailable', () => {
  it('is true when node:sqlite loads', () => {
    expect(Effect.runSync(nodeSqliteAvailable(() => {}))).toBe(true);
  });

  it('is false instead of failing when node:sqlite is missing', () => {
    const missing = () => {
      throw Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    };
    expect(Effect.runSync(nodeSqliteAvailable(missing))).toBe(false);
  });
});
