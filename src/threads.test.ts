import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Context, Deferred, Effect, Exit, Layer, Option, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Branches } from './branches';
import { FullAutoOptIn } from './fullAutoOptIn';
import { Ids } from './ids';
import type { ExtensionMessage } from './protocol';
import { FakeAdapter } from './testing/fakeAdapter';
import type { Post, Workspace } from './thread';
import { makeThreads } from './threads';
import { ThreadStore } from './threadStore';
import { GitRunner, Worktrees, type Worktree } from './worktrees';

/** A webview double recording what it is sent. */
function webview() {
  const messages: ExtensionMessage[] = [];
  const post: Post = (message) => Effect.sync(() => void messages.push(message));
  return { messages, post, types: () => messages.map((message) => message.type) };
}

/** An in-memory thread store that outlives the windows made over it, as a workspace's database outlives reloads. */
export function memoryStore(): Context.Context<ThreadStore> {
  return Effect.runSync(Layer.build(Layer.orDie(ThreadStore.memory)).pipe(Scope.extend(Effect.runSync(Scope.make()))));
}

/** How a test window is set up; everything left out takes its default. */
interface Setup {
  /** Whether the workspace has already allowed Full auto. */
  readonly optedIn?: boolean;
  /** A real repository for worktree threads, and where their checkouts go. */
  readonly worktree?: { readonly repo: string; readonly storage: string };
  /** The store the window keeps its threads in; share one between two setups to reload. */
  readonly store?: Context.Context<ThreadStore>;
  /** Whether the agents still have the sessions stored threads resume. */
  readonly resumable?: boolean;
  /** The folder the user picks when the sidebar opens with no thread to show; none if they decline. */
  readonly chosen?: Option.Option<Workspace>;
  /** Replaces the worktrees module, which otherwise runs real git. */
  readonly worktrees?: Layer.Layer<Worktrees>;
}

function setup({
  optedIn = false,
  worktree,
  store = memoryStore(),
  resumable = true,
  chosen = Option.some({ cwd: worktree?.repo ?? '/work/uni-agent', name: 'uni-agent' }),
  worktrees,
}: Setup = {}) {
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
    worktrees ?? Worktrees.live({
      storagePath: worktree?.storage ?? path.join(os.tmpdir(), 'uni-agent-no-worktrees'),
      isTrusted: () => true,
      setupCommand: () => 'echo ready > setup.txt',
    }).pipe(Layer.provide(GitRunner.live))
  );
  const scope = Effect.runSync(Scope.make());
  const threads = Effect.runSync(
    makeThreads(
      { fallback: () => ({ cwd: worktree?.repo ?? '/work/uni-agent', name: 'uni-agent' }), choose: Effect.succeed(chosen) },
      (agent) => FakeAdapter.maker(made, agent, resumable),
      () => Effect.void
    ).pipe(Scope.extend(scope), Effect.provide(services), Effect.provide(store))
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
    const { threads, run, close } = setup({ worktree: { repo, storage: path.join(root, 'storage') } });
    try {
      await run(threads.connect(webview().post));
      const isolated = await run(threads.createInWorktree('cursor'));
      expect(isolated.workspace.cwd).toContain('thread-2');
      expect(await fs.readFile(path.join(isolated.workspace.cwd, 'setup.txt'), 'utf8')).toContain('ready');
      const review = await run(threads.reviewWorktree(isolated.id));
      expect(review?.diffStat).toContain('setup.txt');
      expect(await run(threads.reviewWorktree('thread-1'))).toBeUndefined();
      expect(await run(threads.remove(isolated.id, true))).toBe(true);
      expect(threads.shown()?.id).toBe('thread-1');
      expect(execFileSync('git', ['branch', '--list', 'uni/thread-2'], { cwd: repo }).toString().trim()).toBe('');
    } finally {
      await close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an unprompted worktree thread it archives, so its checkout is never orphaned', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-threads-test-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    const store = memoryStore();
    const first = setup({ worktree: { repo, storage: path.join(root, 'storage') }, store });
    try {
      await first.run(first.threads.connect(webview().post));
      const isolated = await first.run(first.threads.createInWorktree('codex'));
      await first.run(first.threads.archive(isolated.id));
      expect(first.threads.archived().map((thread) => [thread.id, thread.title, thread.worktree?.path])).toEqual([[isolated.id, undefined, isolated.workspace.cwd]]);
      await first.close();

      // After a reload it is still reachable, so deleting it removes the checkout.
      const reloaded = setup({ worktree: { repo, storage: path.join(root, 'storage') }, store });
      expect(reloaded.threads.archived().map((thread) => thread.id)).toEqual([isolated.id]);
      expect(await reloaded.run(reloaded.threads.remove(isolated.id, true))).toBe(true);
      await expect(fs.access(isolated.workspace.cwd)).rejects.toThrow();
      await reloaded.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a worktree thread archived when git cannot remove its checkout, so Delete can be retried', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-threads-test-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    const store = memoryStore();
    const first = setup({ worktree: { repo, storage: path.join(root, 'storage') }, store });
    try {
      await first.run(first.threads.connect(webview().post));
      const isolated = await first.run(first.threads.createInWorktree('codex'));
      // A locked checkout needs a second --force, so removing it fails.
      execFileSync('git', ['worktree', 'lock', isolated.workspace.cwd], { cwd: repo });

      await expect(first.run(first.threads.remove(isolated.id, true))).rejects.toThrow();
      expect(first.threads.list().map((thread) => thread.id)).not.toContain(isolated.id);
      expect(first.threads.archived().map((thread) => [thread.id, thread.worktree?.path])).toEqual([[isolated.id, isolated.workspace.cwd]]);
      await fs.access(isolated.workspace.cwd);
      await first.close();

      // Still reachable after a reload, so once the lock is gone Delete finishes the job.
      execFileSync('git', ['worktree', 'unlock', isolated.workspace.cwd], { cwd: repo });
      const reloaded = setup({ worktree: { repo, storage: path.join(root, 'storage') }, store });
      expect(reloaded.threads.archived().map((thread) => thread.id)).toEqual([isolated.id]);
      expect(await reloaded.run(reloaded.threads.remove(isolated.id, true))).toBe(true);
      expect(reloaded.threads.archived()).toEqual([]);
      await expect(fs.access(isolated.workspace.cwd)).rejects.toThrow();
      expect(execFileSync('git', ['branch', '--list', `uni/${isolated.id}`], { cwd: repo }).toString().trim()).toBe('');
      await reloaded.close();
    } finally {
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

  it('asks for the folder of the thread the sidebar opens with, and opens none if the user declines', async () => {
    const other = { cwd: '/work/docs', name: 'docs' };
    const picked = setup({ chosen: Option.some(other) });
    const view = webview();
    await picked.run(picked.threads.connect(view.post));
    expect(picked.threads.shown()?.workspace).toEqual(other);
    expect(historyOf(view.messages)).toMatchObject({ thread: { workspace: 'docs' } });

    const declined = setup({ chosen: Option.none() });
    const unseen = webview();
    await declined.run(declined.threads.connect(unseen.post));
    expect(declined.threads.list()).toEqual([]);
    expect(unseen.messages).toEqual([]);
  });

  it('sets up a worktree without holding up prompts to other threads', async () => {
    const created = Effect.runSync(Deferred.make<Worktree>());
    const worktree: Worktree = { path: '/storage/thread-2', branch: 'uni/thread-2', base: 'abc123', repo: '/work/uni-agent' };
    const slow = Layer.succeed(Worktrees, {
      create: () => Deferred.await(created),
      review: (checkout) => Effect.succeed({ worktree: checkout, status: '', diffStat: '' }),
      remove: () => Effect.void,
      exists: () => Effect.succeed(true),
    });
    const { threads, made, run } = setup({ worktrees: slow });
    const view = webview();
    await run(threads.connect(view.post));

    const creating = Effect.runPromise(threads.createInWorktree('codex'));
    // While the setup command runs, the shown thread still takes its prompt.
    expect(await run(threads.submit(view.post, 'thread-1', 'Meanwhile'))).toEqual({ status: 'accepted' });
    expect(made[0].prompts).toHaveLength(1);

    await Effect.runPromise(Deferred.succeed(created, worktree));
    expect(await creating).toMatchObject({ id: 'thread-2', worktree, shown: true });
  });

  it('shows the untouched current thread again instead of creating another', async () => {
    const { threads, run } = setup();
    await run(threads.connect(webview().post));

    const again = await run(threads.create());

    expect(again.id).toBe('thread-1');
    expect(threads.list()).toHaveLength(1);
  });

  it('creates threads with the chosen agent, and new threads keep the shown thread’s agent', async () => {
    const { threads, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));

    const codex = await run(threads.create('codex'));
    expect(codex).toMatchObject({ id: 'thread-2', agent: 'codex', workspace: { name: 'uni-agent' }, shown: true });
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-2', agent: 'codex' } });

    // The untouched Codex thread is shown again rather than duplicated.
    expect((await run(threads.create())).id).toBe('thread-2');
    expect(await run(threads.create('cursor'))).toMatchObject({ id: 'thread-3', agent: 'cursor' });
    expect(threads.list().map((thread) => thread.agent)).toEqual(['cursor', 'codex', 'claude']);
  });

  it('changes an empty thread’s agent under the same ID, then locks it on the first accepted prompt', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));

    await run(threads.setAgent('thread-1', 'codex'));
    expect(threads.shown()).toMatchObject({ id: 'thread-1', agent: 'codex' });
    expect(threads.list()).toHaveLength(1);
    expect(made[0].disposed).toBe(true);
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-1', agent: 'codex' }, model: null });

    await run(threads.prompt('thread-1', 'First'));
    await run(threads.setAgent('thread-1', 'cursor'));
    expect(threads.shown()?.agent).toBe('codex');
  });

  it('applies model changes between prompts and keeps the selection in history', async () => {
    const { threads, made, run } = setup();
    const view = webview();
    await run(threads.connect(view.post));
    await run(threads.setModel('thread-1', 'claude', 'model-a'));
    expect(made[0].models).toEqual(['model-a']);
    expect(view.messages.at(-1)).toEqual({ type: 'model', threadId: 'thread-1', model: 'model-a' });
    // A request made before the thread's agent changed is ignored.
    await run(threads.setModel('thread-1', 'codex', 'gpt-6'));
    expect(made[0].models).toEqual(['model-a']);

    await run(threads.prompt('thread-1', 'First'));
    await run(threads.setModel('thread-1', 'claude', 'model-b'));
    expect(made[0].models).toEqual(['model-a']);
    await made[0].endTurn();
    await run(threads.setModel('thread-1', 'claude', 'model-b'));
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
    expect(second.id).toBe('thread-2');
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
    expect(threads.list().map((thread) => thread.id)).toEqual(['thread-2', 'thread-1']);
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

    expect(await run(threads.submit(view.post, 'thread-1', 'stale'))).toEqual({ status: 'rejected', reason: 'stale' });
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
    expect(threads.list().some((thread) => thread.status === 'needs_approval')).toBe(false);
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
    const { threads, made, run } = setup({ optedIn: true });
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

/** Lets forked turns, and the events they emit, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Threads across reloads', () => {
  it('restores stored threads without starting their agents, and resumes the session with the next prompt', async () => {
    const store = memoryStore();
    const first = setup({ store });
    await first.run(first.threads.connect(webview().post));
    await first.run(first.threads.prompt('thread-1', 'Fix the build'));
    await first.made[0].say('Done.');
    await first.made[0].endTurn();
    // An untouched thread is not stored.
    await first.run(first.threads.create('codex'));
    await first.close();

    const reloaded = setup({ store });
    expect(reloaded.threads.list().map((thread) => [thread.id, thread.agent, thread.workspace.name, thread.title, thread.status])).toEqual([
      ['thread-1', 'claude', 'uni-agent', 'Fix the build', 'idle'],
    ]);
    const view = webview();
    await reloaded.run(reloaded.threads.connect(view.post));

    // The newest thread is shown from the store; no agent has been made for it yet.
    const history = historyOf(view.messages);
    expect(history?.type === 'history' && history.events.map(({ event }) => event.type)).toEqual(['turn_started', 'session_update', 'turn_ended']);
    expect(history).toMatchObject({ readOnly: null, events: [expect.anything(), { event: { update: { content: { text: 'Done.' } } } }, expect.anything()] });
    expect(reloaded.made).toEqual([]);

    expect(await reloaded.run(reloaded.threads.submit(view.post, 'thread-1', 'And the tests'))).toEqual({ status: 'accepted' });
    await settle();
    expect(reloaded.made).toHaveLength(1);
    expect(reloaded.made[0].resumed).toBe('session-1');
    expect(reloaded.made[0].prompts).toEqual([[{ type: 'text', text: 'And the tests' }]]);
    expect(view.messages.at(-1)).toMatchObject({ type: 'event', threadId: 'thread-1', event: { type: 'turn_started', turnId: 'resumed-turn-1' } });
  });

  it('makes a thread read-only when its session cannot be resumed, and keeps it read-only after the next reload', async () => {
    const store = memoryStore();
    const first = setup({ store });
    await first.run(first.threads.connect(webview().post));
    await first.run(first.threads.prompt('thread-1', 'Hello'));
    await first.made[0].endTurn();
    await first.close();

    const reloaded = setup({ store, resumable: false });
    const view = webview();
    await reloaded.run(reloaded.threads.connect(view.post));
    await reloaded.run(reloaded.threads.prompt('thread-1', 'Again'));
    await settle();

    const [thread] = reloaded.threads.list();
    expect(thread.status).toBe('read_only');
    expect(view.messages).toContainEqual({ type: 'read_only', threadId: 'thread-1', reason: 'Session can’t be resumed — start a new thread.' });
    expect(await reloaded.run(reloaded.threads.prompt('thread-1', 'Once more'))).toEqual({ status: 'rejected', reason: 'read_only' });
    expect(reloaded.made).toHaveLength(1);
    await reloaded.close();

    const again = setup({ store });
    const next = webview();
    await again.run(again.threads.connect(next.post));
    expect(historyOf(next.messages)).toMatchObject({ readOnly: 'Session can’t be resumed — start a new thread.' });
    expect(again.threads.list()[0].status).toBe('read_only');
  });

  it('ends a turn a reload cut off as interrupted, and the thread takes the next prompt', async () => {
    const store = memoryStore();
    const first = setup({ store });
    await first.run(first.threads.connect(webview().post));
    await first.run(first.threads.prompt('thread-1', 'Long job'));
    await first.made[0].say('Halfway');
    // Starting to ask finishes the message; the ask itself is still open when the window reloads,
    // without the turn ending: its scope is never closed.
    await first.made[0].askPermission('request-1');

    const reloaded = setup({ store });
    const view = webview();
    await reloaded.run(reloaded.threads.connect(view.post));
    const history = historyOf(view.messages);
    expect(history?.type === 'history' && history.events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'turn_started' }),
      expect.objectContaining({ type: 'session_update' }),
      { type: 'turn_ended', turnId: 'turn-1', stopReason: 'interrupted' },
    ]);
    expect(reloaded.threads.list()[0].status).toBe('idle');
    expect(await reloaded.run(reloaded.threads.prompt('thread-1', 'Carry on'))).toEqual({ status: 'accepted' });
  });

  it('restores the model and mode, but Full auto only while the workspace still allows it', async () => {
    const store = memoryStore();
    const first = setup({ optedIn: true, store });
    await first.run(first.threads.connect(webview().post));
    await first.run(first.threads.setModel('thread-1', 'claude', 'claude-sonnet-4-6'));
    await first.run(first.threads.setMode('thread-1', 'full_auto'));
    await first.run(first.threads.prompt('thread-1', 'Go'));
    await first.made[0].endTurn();
    await first.close();

    const allowed = setup({ optedIn: true, store });
    const allowedView = webview();
    await allowed.run(allowed.threads.connect(allowedView.post));
    expect(historyOf(allowedView.messages)).toMatchObject({ mode: 'full_auto', model: 'claude-sonnet-4-6' });
    await allowed.close();

    const refused = setup({ store });
    const refusedView = webview();
    await refused.run(refused.threads.connect(refusedView.post));
    expect(historyOf(refusedView.messages)).toMatchObject({ mode: 'auto_edit', model: 'claude-sonnet-4-6' });
    await refused.run(refused.threads.prompt('thread-1', 'Go on'));
    await settle();
    expect(refused.made[0].modes).toEqual(['auto_edit']);
  });

  it('archives a thread out of the window, keeps it stored, and brings it back', async () => {
    const store = memoryStore();
    const first = setup({ store });
    const view = webview();
    await first.run(first.threads.connect(view.post));
    await first.run(first.threads.prompt('thread-1', 'Keep me'));
    await first.run(first.threads.create());
    await first.run(first.threads.prompt('thread-2', 'Me too'));
    await first.made[1].endTurn();

    await first.run(first.threads.archive('thread-2'));
    expect(first.made[1].disposed).toBe(true);
    expect(first.threads.list().map((thread) => thread.id)).toEqual(['thread-1']);
    expect(first.threads.archived().map((thread) => [thread.id, thread.title])).toEqual([['thread-2', 'Me too']]);
    // The archived thread was shown, so the sidebar moved on to the next one.
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-1' } });
    await first.close();

    const reloaded = setup({ store });
    expect(reloaded.threads.list().map((thread) => thread.id)).toEqual(['thread-1']);
    expect(reloaded.threads.archived().map((thread) => thread.id)).toEqual(['thread-2']);

    const next = webview();
    await reloaded.run(reloaded.threads.connect(next.post));
    await reloaded.run(reloaded.threads.unarchive('thread-2'));
    expect(reloaded.threads.archived()).toEqual([]);
    expect(reloaded.threads.list().map((thread) => thread.id)).toEqual(['thread-2', 'thread-1']);
    expect(historyOf(next.messages)).toMatchObject({ thread: { id: 'thread-2' }, events: [{ event: { type: 'turn_started' } }, { event: { type: 'turn_ended', stopReason: 'end_turn' } }] });
  });

  it('deletes threads, archived or not, from the window and the store', async () => {
    const store = memoryStore();
    const first = setup({ store });
    const view = webview();
    await first.run(first.threads.connect(view.post));
    await first.run(first.threads.prompt('thread-1', 'One'));
    await first.run(first.threads.create());
    await first.run(first.threads.prompt('thread-2', 'Two'));
    await first.run(first.threads.archive('thread-1'));

    expect(await first.run(first.threads.remove('thread-1'))).toBe(true);
    expect(await first.run(first.threads.remove('thread-2'))).toBe(true);
    expect(await first.run(first.threads.remove('thread-9'))).toBe(false);
    expect(first.threads.archived()).toEqual([]);
    // Nothing was left to show, so the connected sidebar was given a new thread.
    expect(first.threads.list().map((thread) => thread.id)).toEqual(['thread-3']);
    expect(historyOf(view.messages)).toMatchObject({ thread: { id: 'thread-3' } });
    await first.close();

    const reloaded = setup({ store });
    expect(reloaded.threads.list()).toEqual([]);
    expect(reloaded.threads.archived()).toEqual([]);
  });

  it('makes a restored worktree thread read-only when its checkout is gone', async () => {
    const store = memoryStore();
    const worktree = { path: '/nowhere/uni-agent-worktree', branch: 'uni/thread-1', base: 'abc123', repo: '/work/uni-agent' };
    const record = Context.get(store, ThreadStore).record({ id: 'thread-1', agent: 'codex', workspace: { cwd: worktree.path, name: 'uni-agent · worktree' }, worktree });
    await Effect.runPromise(record.save({ title: 'Isolated work', sessionId: undefined, mode: 'auto_edit', model: undefined, readOnly: undefined }));

    const { threads, run } = setup({ store });
    const view = webview();
    await run(threads.connect(view.post));

    expect(threads.list()[0]).toMatchObject({ status: 'read_only', worktree });
    expect(historyOf(view.messages)).toMatchObject({ readOnly: 'Its worktree checkout at /nowhere/uni-agent-worktree is gone. Session can’t be resumed — start a new thread.' });
  });
});
