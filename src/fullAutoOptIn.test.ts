import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { WireMessage } from './agents/traffic';
import { FullAutoOptIn } from './fullAutoOptIn';

/** A workspace state that holds `stored` as the opt-in, if given. */
function memento(stored?: WireMessage) {
  const values = new Map<string, unknown>();
  if (stored !== undefined) {
    values.set('uniAgent.fullAutoOptIn', stored);
  }
  const state: Pick<vscode.Memento, 'get' | 'update'> = {
    get: (key: string) => values.get(key),
    update: async (key, value) => void values.set(key, value),
  };
  // SAFETY: FullAutoOptIn only calls `get` and `update`, which the double implements.
  return state as vscode.Memento;
}

const granted = (state: vscode.Memento) => Effect.runPromise(Effect.flatMap(FullAutoOptIn, (optIn) => optIn.granted).pipe(Effect.provide(FullAutoOptIn.live(state))));

describe('FullAutoOptIn', () => {
  it('is not granted in a workspace that never opted in', async () => {
    expect(await granted(memento())).toBe(false);
  });

  it('remembers the opt-in in the workspace state', async () => {
    const state = memento();
    await Effect.runPromise(Effect.flatMap(FullAutoOptIn, (optIn) => optIn.grant).pipe(Effect.provide(FullAutoOptIn.live(state))));

    expect(await granted(state)).toBe(true);
  });

  it('counts a stored value of another shape as not opted in', async () => {
    expect(await granted(memento('yes'))).toBe(false);
  });
});
