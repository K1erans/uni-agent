import { describe, expect, it } from 'vitest';
import { isNodeSqliteAvailable } from './nodeSqlite';

describe('isNodeSqliteAvailable', () => {
  it('is true when node:sqlite loads', () => {
    expect(isNodeSqliteAvailable(() => ({}))).toBe(true);
  });

  it('is false instead of throwing when node:sqlite is missing', () => {
    const missing = () => {
      throw Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    };
    expect(isNodeSqliteAvailable(missing)).toBe(false);
  });
});
