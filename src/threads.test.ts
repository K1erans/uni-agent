import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Effect, Exit, Layer, Option, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Branches } from './branches';
import { FullAutoOptIn } from './fullAutoOptIn';
import { Ids } from './ids';
import type { ExtensionMessage } from './protocol';
import { FakeAdapter } from './testing/fakeAdapter';
import type { Post } from './thread';
import { makeThreads } from './threads';
import { GitRunner } from './worktrees';

/** A webview double recording what it is sent. */
function webview() {
  const messages: ExtensionMessage[] = [];
  const post: Post = (message) => Effect.sync(() => void messages.push(message));
  return { messages, post, types: () => messages.map((message) => message.type) };
}

/** @param optedIn Whether the workspace has already allowed Full auto. */
function setup(optedIn = false, worktree?: { readonly repo: string; readonly storage: string }) {
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
    }),
    Layer.succeed(FullAutoOptIn, { granted: Effect.succeed(optedIn), grant: Effect.void }),
    GitRunner.live
  );
  const scope = Effect.runSync(Scope.make());
  const threads = Effect.runSync(
    makeThreads(
      () => ({ cwd: worktree?.repo ?? '/work/uni-agent', name: 'uni-agent' }),
      (agent) => FakeAdapter.maker(made, agent),
      () => Effect.void,
      worktree ? { storagePath: worktree.storage, setupCommand: () => 'echo ready > setup.txt' } : undefined
    ).pipe(Scope.extend(scope), Effect.provide(services))
  );
  return {
    threads,
    made,
    watching,
    /** Runs an effect and lets any turn it forks start. */
    run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.tap(effect, () => Effect.yieldNow())),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const historyOf = (messages: ExtensionMessage[]) => messages.filter((message) => message.type === 'history').at(-1);

describe('Threads', () => {
  it('creates, reviews, and discards a VS Code worktree thread', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-threads-test-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    const { threads, run, close } = setup(false, { repo, storage: path.join(root, 'storage') });
    try {
      await run(threads.connect(webview().post));
      const isolated = await run(threads.createInWorktree('cursor'));
      expect(isolated.workspace.cwd).toContain('thread-2');
      expect(await fs.readFile(path.join(isolated.workspace.cwd, 'setup.txt'), 'utf8')).toContain('ready');
      const review = await run(threads.reviewCurrentWorktree());
      expect(review?.diffStat).toContain('setup.txt');
      expect(await run(threads.removeCurrentWorktree(true))).toBe(true);
      expect(threads.current?.info.id).toBe('thread-1');
      expect(execFileSync('git', ['branch', '--list', 'uni/thread-2'], { cwd: repo }).toString().trim()).toBe('');
    } finally {
      await close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('creates a thread for the first webview and sends it the thread, then its branch', async () => {
    const { threads, run, watching } = setup();
    const view = webview();

    await run(threads.connect(view.post));

    expect(view.types()).toEqual(['history', 'branch']);
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' } });
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

  it('creates threads with the chosen agent, and new threads keep the shown thread’s agent', async () => {
    const { threads, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));

    const codex = await run(threads.create('codex'));
    expect(codex.info).toEqual({ id: 'thread-2', agent: 'codex', workspace: 'uni-agent' });
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-2', agent: 'codex' } });

    // The untouched Codex thread is shown again rather than duplicated.
    expect((await run(threads.create())).info.id).toBe('thread-2');
    expect((await run(threads.create('cursor'))).info).toMatchObject({ id: 'thread-3', agent: 'cursor' });
    expect(threads.list().map((thread) => thread.info.agent)).toEqual(['cursor', 'codex', 'claude']);
  });

  it('changes an empty thread’s agent under the same ID, then locks it on the first accepted prompt', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));

    await run(threads.setAgent('thread-1', 'codex'));
    expect(threads.current?.info).toMatchObject({ id: 'thread-1', agent: 'codex' });
    expect(threads.list()).toHaveLength(1);
    expect(made[0].disposed).toBe(true);
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-1', agent: 'codex' }, model: null });

    await run(threads.prompt('thread-1', 'First'));
    await run(threads.setAgent('thread-1', 'cursor'));
    expect(threads.current?.info.agent).toBe('codex');
  });

  it('applies model changes between prompts and keeps the selection in history', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));
    await run(threads.setModel('thread-1', 'model-a'));
    expect(made[0].models).toEqual(['model-a']);
    expect(threads.current?.selectedModel).toBe('model-a');

    await run(threads.prompt('thread-1', 'First'));
    await run(threads.setModel('thread-1', 'model-b'));
    expect(made[0].models).toEqual(['model-a']);
    await made[0].endTurn();
    await run(threads.setModel('thread-1', 'model-b'));
    expect(made[0].models).toEqual(['model-a', 'model-b']);
    await run(threads.disconnect(view.post));
    const reopened = webview();
    await run(threads.connect(reopened.post));
    expect(historyOf(reopened.messages)).toMatchObject({ model: 'model-b' });
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

  it('ignores a connection that was still queued when its webview closed', async () => {
    const { threads, run, watching } = setup();
    const closed = webview();

    // VS Code disposed the view before its `ready` message was handled.
    await run(threads.disconnect(closed.post));
    await run(threads.connect(closed.post));

    expect(closed.messages).toEqual([]);
    expect(watching).toEqual([]);
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

  it('rejects stale sidebar submissions while allowing intentional background prompts', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));
    await run(threads.create('codex'));

    expect(await run(threads.submitSidebar(view.post, 'thread-1', 'stale'))).toEqual({ status: 'rejected', reason: 'stale' });
    expect(made[0].prompts).toHaveLength(0);
    expect(await run(threads.prompt('thread-1', 'intentional background'))).toEqual({ status: 'accepted' });
    expect(made[0].prompts[0][0].text).toBe('intentional background');
  });

  it('answers permission requests in the thread they name, whether or not it is shown', async () => {
    const { threads, made, run } = setup();
    await run(threads.connect(webview().post));
    await run(threads.prompt('thread-1', 'For the first thread'));
    await made[0].askPermission('permission-1');
    // The user switches away before answering; the thread waiting is still the one that gets it.
    await run(threads.create());

    await run(threads.respond('thread-1', 'permission-1', 'allow'));
    await run(threads.respond('thread-9', 'permission-1', 'allow'));

    expect(made[0].answers).toEqual([['permission-1', 'allow']]);
    expect(threads.list().some((thread) => thread.needsApproval)).toBe(false);
  });

  it('starts threads in Auto-edit and switches the named thread mid-thread, telling its webview', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));
    await run(threads.prompt('thread-1', 'Look around'));

    await run(threads.setMode('thread-1', 'plan'));
    await run(threads.setMode('thread-9', 'plan'));

    expect(historyOf(view.messages)).toMatchObject({ mode: 'auto_edit' });
    expect(made[0].modes).toEqual(['auto_edit', 'plan']);
    expect(view.messages.at(-1)).toEqual({ type: 'mode', threadId: 'thread-1', mode: 'plan' });
    // A webview that reconnects is told the thread's current mode.
    const again = webview();
    await run(threads.connect(again.post));
    expect(historyOf(again.messages)).toMatchObject({ mode: 'plan' });
  });

  it('keeps a thread out of Full auto until the workspace has opted in', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));

    await run(threads.setMode('thread-1', 'full_auto'));

    expect(made[0].modes).toEqual(['auto_edit']);
    expect(view.types()).not.toContain('mode');
  });

  it('switches to Full auto once the workspace has opted in', async () => {
    const { threads, made, run } = setup(true);
    await run(threads.connect(webview().post));

    await run(threads.setMode('thread-1', 'full_auto'));

    expect(made[0].modes).toEqual(['auto_edit', 'full_auto']);
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
