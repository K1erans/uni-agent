import { Effect, Exit, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from './protocol';
import { FakeAdapter } from './testing/fakeAdapter';
import { HISTORY_UNREADABLE, makeThread } from './thread';

/** Opens a thread over a fake adapter; `prompt` lets forked turns start before it returns. */
function setup() {
  const made: FakeAdapter[] = [];
  const scope = Effect.runSync(Scope.make());
  const thread = Effect.runSync(
    makeThread('thread-1', { cwd: '/work/uni-agent', name: 'uni-agent' }, FakeAdapter.maker(made)).pipe(Scope.extend(scope))
  );
  return {
    thread,
    adapter: made[0],
    attach: (post: (message: ExtensionMessage) => void) => Effect.runSync(thread.attach((message) => Effect.sync(() => post(message)))),
    prompt: (text: string) => Effect.runPromise(Effect.tap(thread.prompt(text), () => Effect.yieldNow())),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

describe('Thread', () => {
  it('reserves one turn, rejects a busy prompt, and returns its reviewable result', async () => {
    const { thread, adapter, prompt } = setup();
    expect(await prompt('   ')).toEqual({ status: 'rejected', reason: 'empty' });
    const admitted = await prompt('First');
    expect(admitted.status).toBe('accepted');
    expect(await prompt('Second')).toEqual({ status: 'rejected', reason: 'busy' });
    await adapter.say('Done.');
    await adapter.endTurn();
    if (admitted.status !== 'accepted') {
      throw new Error('Expected an accepted prompt');
    }
    expect(await Effect.runPromise(admitted.completion)).toMatchObject({
      agent: 'claude', sessionId: adapter.sessionId, stopReason: 'end_turn', response: 'Done.',
    });
    expect(thread.title).toBe('First');
  });

  it('replays its history to every webview that attaches, then forwards new events', async () => {
    const { adapter, attach, prompt } = setup();
    const first = vi.fn();
    attach(first);
    await prompt('hi');

    // A reloaded webview gets the thread and everything so far, with when each event arrived.
    const second = vi.fn();
    attach(second);
    expect(second).toHaveBeenCalledWith({
      type: 'history',
      thread: { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' },
      mode: 'auto_edit',
      model: null,
      readOnly: null,
      events: [
        { event: expect.objectContaining({ type: 'session_started' }), at: expect.any(Number) },
        { event: expect.objectContaining({ type: 'turn_started' }), at: expect.any(Number) },
      ],
    });

    await adapter.endTurn();
    expect(second).toHaveBeenLastCalledWith({
      type: 'event',
      threadId: 'thread-1',
      event: expect.objectContaining({ type: 'turn_ended' }),
      at: expect.any(Number),
    });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('stops forwarding events once detached', async () => {
    const { thread, adapter, attach, prompt } = setup();
    const post = vi.fn();
    attach(post);
    Effect.runSync(thread.detach());

    await prompt('hi');
    expect(post).toHaveBeenCalledTimes(1);
    expect(adapter.prompts).toHaveLength(1);
  });

  it('ignores prompts while a turn is running and blank prompts', async () => {
    const { adapter, prompt } = setup();

    await prompt('   ');
    // Sent back to back, before the first turn's fiber has started.
    await Promise.all([prompt('one'), prompt('two')]);
    await adapter.endTurn();
    await prompt('three');

    expect(adapter.prompts.map(([block]) => block.text)).toEqual(['one', 'three']);
  });

  it('takes its title from the first line of its first prompt', async () => {
    const { thread, adapter, prompt } = setup();
    expect(thread.isEmpty).toBe(true);
    expect(thread.title).toBeUndefined();

    await prompt('  Add thread search\nKeep the styling consistent.');
    await adapter.endTurn();
    await prompt('And a keyboard shortcut');

    expect(thread.isEmpty).toBe(false);
    expect(thread.title).toBe('Add thread search');
  });

  it('flags that it is waiting for an answer, and routes the answer to its adapter', async () => {
    const { thread, adapter, prompt } = setup();
    await prompt('hi');
    expect(thread.needsApproval).toBe(false);

    await adapter.askPermission('permission-1');
    expect(thread.needsApproval).toBe(true);

    await Effect.runPromise(thread.respond('permission-1', 'allow'));
    expect(adapter.answers).toEqual([['permission-1', 'allow']]);
    expect(thread.needsApproval).toBe(false);
  });

  it('drops an answer for a request the adapter no longer has open', async () => {
    const { thread, adapter, prompt } = setup();
    await prompt('hi');
    await adapter.askPermission('permission-1');
    await Effect.runPromise(thread.respond('permission-1', 'allow'));

    await Effect.runPromise(thread.respond('permission-1', 'allow'));
    expect(adapter.answers).toEqual([['permission-1', 'allow']]);
  });

  it('switches its adapter to a new mode mid-turn, and tells the connected webview', async () => {
    const { thread, adapter, attach, prompt } = setup();
    const post = vi.fn();
    attach(post);
    await prompt('hi');

    await Effect.runPromise(thread.setMode('plan'));

    expect(thread.mode).toBe('plan');
    expect(adapter.modes).toEqual(['auto_edit', 'plan']);
    expect(post).toHaveBeenLastCalledWith({ type: 'mode', threadId: 'thread-1', mode: 'plan' });
  });

  it('keeps its mode, and tells the webview nothing, when the agent refuses a switch', async () => {
    const { thread, adapter, attach, prompt } = setup();
    const post = vi.fn();
    attach(post);
    await prompt('hi');
    adapter.refusesModes = true;

    await Effect.runPromise(thread.setMode('plan'));

    expect(thread.mode).toBe('auto_edit');
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mode' }));
  });

  it('stops the adapter when its scope closes', async () => {
    const { adapter, close } = setup();
    await close();
    expect(adapter.disposed).toBe(true);
  });

  it('restores a stored thread lazily, and makes it read-only when some of its history cannot be read', async () => {
    const made: FakeAdapter[] = [];
    const scope = Effect.runSync(Scope.make());
    let loads = 0;
    const thread = Effect.runSync(
      makeThread('thread-1', { cwd: '/work/uni-agent', name: 'uni-agent' }, FakeAdapter.maker(made), {
        restored: {
          agent: 'codex',
          sessionId: 'stored-session',
          title: 'Fix the build',
          readOnly: undefined,
          history: Effect.sync(() => {
            loads++;
            return { events: [{ event: { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Fix the build' }] }, at: 1 }], complete: false };
          }),
        },
      }).pipe(Scope.extend(scope))
    );
    expect([thread.info.agent, thread.title, thread.isEmpty, loads, made.length]).toEqual(['codex', 'Fix the build', false, 0, 0]);

    const sent: ExtensionMessage[] = [];
    Effect.runSync(thread.attach((message) => Effect.sync(() => void sent.push(message))));
    Effect.runSync(thread.attach((message) => Effect.sync(() => void sent.push(message))));

    expect(loads).toBe(1);
    expect(sent.at(-1)).toMatchObject({ type: 'history', readOnly: HISTORY_UNREADABLE, events: [{ event: { type: 'turn_started' } }] });
    expect(thread.status).toBe('read_only');
    expect(await Effect.runPromise(thread.prompt('Again'))).toEqual({ status: 'rejected', reason: 'read_only' });
    expect(made).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it('rejects a prompt to a thread never shown when loading finds its history unreadable', async () => {
    const made: FakeAdapter[] = [];
    const scope = Effect.runSync(Scope.make());
    const thread = Effect.runSync(
      makeThread('thread-1', { cwd: '/work/uni-agent', name: 'uni-agent' }, FakeAdapter.maker(made), {
        restored: {
          agent: 'codex',
          sessionId: 'stored-session',
          title: 'Fix the build',
          readOnly: undefined,
          history: Effect.succeed({ events: [], complete: false }),
        },
      }).pipe(Scope.extend(scope))
    );

    expect(await Effect.runPromise(thread.prompt('Again'))).toEqual({ status: 'rejected', reason: 'read_only' });
    expect(thread.readOnly).toBe(HISTORY_UNREADABLE);
    expect(made).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
