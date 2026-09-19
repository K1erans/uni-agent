import { Effect, Exit, Layer, Option, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Branches } from './branches';
import { Ids } from './ids';
import type { ExtensionMessage } from './protocol';
import { FakeAdapter } from './testing/fakeAdapter';
import type { Post } from './thread';
import { makeThreads } from './threads';

/** A webview double recording what it is sent. */
function webview() {
  const messages: ExtensionMessage[] = [];
  const post: Post = (message) => Effect.sync(() => void messages.push(message));
  return { messages, post, types: () => messages.map((message) => message.type) };
}

function setup() {
  const made: FakeAdapter[] = [];
  /** The folders whose branch is being watched right now. */
  const watching: string[] = [];
  let ids = 0;
  const services = Layer.mergeAll(
    Layer.succeed(Ids, { next: Effect.sync(() => `thread-${++ids}`) }),
    Layer.succeed(Branches, {
      watch: (cwd, onChange) =>
        Effect.gen(function* () {
          watching.push(cwd);
          yield* Effect.addFinalizer(() => Effect.sync(() => watching.splice(watching.indexOf(cwd), 1)));
          yield* onChange(Option.some('main'));
        }),
    })
  );
  const scope = Effect.runSync(Scope.make());
  const threads = Effect.runSync(
    makeThreads(
      () => ({ cwd: '/work/uni-agent', name: 'uni-agent' }),
      () => FakeAdapter.maker(made)
    ).pipe(Scope.extend(scope), Effect.provide(services))
  );
  return {
    threads,
    made,
    watching,
    /** Runs an effect and lets any turn it forks start. */
    run: <A>(effect: Effect.Effect<A>) => Effect.runPromise(Effect.tap(effect, () => Effect.yieldNow())),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const historyOf = (messages: ExtensionMessage[]) => messages.filter((message) => message.type === 'history').at(-1);

describe('Threads', () => {
  it('creates a thread for the first webview and sends it the thread, then its branch', async () => {
    const { threads, run, watching } = setup();
    const view = webview();

    await run(threads.connect(view.post));

    expect(view.types()).toEqual(['history', 'branch']);
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-1', workspace: 'uni-agent' } });
    expect(view.messages[1]).toEqual({ type: 'branch', name: 'main' });
    expect(watching).toEqual(['/work/uni-agent']);
  });

  it('shows the untouched current thread again instead of creating another', async () => {
    const { threads, run } = setup();
    await run(threads.connect(webview().post));

    const again = await run(threads.create());

    expect(again.info.id).toBe('thread-1');
    expect(threads.list()).toHaveLength(1);
  });

  it('switches threads, forwarding only the shown thread and replaying the one switched back to', async () => {
    const { threads, made, run, watching } = setup();
    const view = webview();
    await run(threads.connect(view.post));
    await run(threads.prompt('thread-1', 'First thread'));

    const second = await run(threads.create());
    expect(second.info.id).toBe('thread-2');
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-2' } });

    // The first thread keeps running, but its events no longer reach the webview.
    const sent = view.messages.length;
    await made[0].endTurn();
    expect(view.messages).toHaveLength(sent);

    await run(threads.select('thread-1'));
    const history = historyOf(view.messages);
    expect(history).toMatchObject({ thread: { id: 'thread-1' } });
    expect(history?.type === 'history' && history.events.map(({ event }) => event.type)).toEqual([
      'session_started',
      'turn_started',
      'turn_ended',
    ]);
    // One branch watch at a time, for the shown thread.
    expect(watching).toEqual(['/work/uni-agent']);
    expect(threads.list().map((thread) => thread.info.id)).toEqual(['thread-2', 'thread-1']);
  });

  it('replays the current thread to a webview that reconnects after the sidebar was hidden', async () => {
    const { threads, run, watching } = setup();
    const first = webview();
    await run(threads.connect(first.post));
    await run(threads.prompt('thread-1', 'Hello'));

    await run(threads.disconnect(first.post));
    expect(watching).toEqual([]);

    const second = webview();
    await run(threads.connect(second.post));
    expect(historyOf(second.messages)).toMatchObject({
      thread: { id: 'thread-1' },
      events: [expect.anything(), { event: expect.objectContaining({ type: 'turn_started' }) }],
    });
  });

  it('ignores a disconnect from a webview that has since been replaced', async () => {
    const { threads, run, made } = setup();
    const stale = webview();
    const fresh = webview();
    await run(threads.connect(stale.post));
    await run(threads.connect(fresh.post));

    await run(threads.disconnect(stale.post));
    await run(threads.prompt('thread-1', 'Still connected?'));

    expect(made[0].prompts).toHaveLength(1);
    expect(fresh.messages.at(-1)).toMatchObject({ type: 'event', threadId: 'thread-1', event: { type: 'turn_started' } });
  });

  it('sends prompts to the thread they name, and ignores unknown threads', async () => {
    const { threads, made, run } = setup();
    await run(threads.connect(webview().post));
    await run(threads.prompt('thread-1', 'For the first thread'));
    await run(threads.create());

    await run(threads.prompt('thread-1', 'Queued behind the running turn'));
    await made[0].endTurn();
    await run(threads.prompt('thread-1', 'Second turn'));
    await run(threads.prompt('thread-9', 'Nobody'));

    expect(made[0].prompts.map(([block]) => block.text)).toEqual(['For the first thread', 'Second turn']);
    expect(made[1].prompts).toEqual([]);
  });

  it('stops every thread when its scope closes', async () => {
    const { threads, made, run, close } = setup();
    await run(threads.connect(webview().post));
    await run(threads.prompt('thread-1', 'One'));
    await run(threads.create());

    await close();
    expect(made.map((adapter) => adapter.disposed)).toEqual([true, true]);
  });
});
