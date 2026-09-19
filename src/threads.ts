import { Effect, ExecutionStrategy, Exit, Option, Scope } from 'effect';
import type { MakeAdapter } from './agents/adapter';
import type { AgentKind } from './agents/events';
import { Branches } from './branches';
import { Ids } from './ids';
import { makeThread, type Post, type Thread, type Workspace } from './thread';

/**
 * The window's threads and the one the sidebar shows. The sidebar webview connects when it loads
 * and disconnects when VS Code disposes it (the view hidden or collapsed); the threads and their
 * agents keep running in between, so reopening the sidebar replays the shown thread.
 *
 * Threads live until the extension deactivates: they are not persisted yet.
 */
export interface Threads {
  /** The thread the sidebar shows, if one has been created. */
  readonly current: Thread | undefined;
  /** Every thread, newest first. */
  list(): ReadonlyArray<Thread>;
  /**
   * Connects the sidebar webview and shows it the current thread, creating one if there is none.
   * Ignored for a webview already disconnected, whose connection was still queued when it closed.
   */
  connect(post: Post): Effect.Effect<void>;
  /** Disconnects the webview, if `post` is still the connected one, and stops it connecting again. */
  disconnect(post: Post): Effect.Effect<void>;
  /**
   * Shows a new thread with `agent`, by default the shown thread's agent (Claude when there is
   * none). A current thread with that agent that nobody has prompted yet is shown again instead.
   */
  create(agent?: AgentKind): Effect.Effect<Thread>;
  /** Shows the thread with this ID; unknown IDs are ignored. */
  select(threadId: string): Effect.Effect<void>;
  /** Sends a prompt to the thread with this ID, whether or not it is shown. */
  prompt(threadId: string, text: string): Effect.Effect<void>;
}

/** The agent a thread talks to when nothing chose one. */
const DEFAULT_AGENT: AgentKind = 'claude';

/**
 * @param workspace Where a new thread's agent runs, read when the thread is created.
 * @param makeAdapter Builds the adapter for a thread with the given agent, running in the given workspace.
 */
export function makeThreads<R>(
  workspace: () => Workspace,
  makeAdapter: (agent: AgentKind, workspace: Workspace) => MakeAdapter<R>
): Effect.Effect<Threads, never, R | Ids | Branches | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const ids = yield* Ids;
    const branches = yield* Branches;
    const context = yield* Effect.context<R>();
    // Serialises everything that changes which thread is shown or connected, since VS Code
    // callbacks can start them concurrently.
    const lock = yield* Effect.makeSemaphore(1);
    const serial = lock.withPermits(1);

    const threads: Thread[] = [];
    let current: Thread | undefined;
    let connected: Post | undefined;
    // Webviews VS Code has disposed. Checked under the lock, so a connection queued behind the
    // disconnect cannot attach a closed webview.
    const disconnected = new WeakSet<Post>();
    // Watches the shown thread's branch while a webview is connected.
    let branchWatch: Scope.CloseableScope | undefined;

    const stopBranchWatch = Effect.suspend(() => {
      const watch = branchWatch;
      branchWatch = undefined;
      return watch ? Scope.close(watch, Exit.void) : Effect.void;
    });

    /** Makes `thread` the shown one and, if a webview is connected, sends it the thread. */
    const show = (thread: Thread) =>
      Effect.gen(function* () {
        if (current && current !== thread) {
          yield* current.detach();
        }
        current = thread;
        yield* stopBranchWatch;
        const post = connected;
        if (!post) {
          return;
        }
        yield* thread.attach(post);
        const watch = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        branchWatch = watch;
        yield* branches
          .watch(thread.workspace.cwd, (branch) => post({ type: 'branch', name: Option.getOrNull(branch) }))
          .pipe(Scope.extend(watch));
      });

    const create = (agent = current?.info.agent ?? DEFAULT_AGENT) =>
      Effect.gen(function* () {
        const where = workspace();
        if (current?.isEmpty && current.info.agent === agent && current.workspace.cwd === where.cwd) {
          return current;
        }
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        const thread = yield* makeThread(yield* ids.next, where, makeAdapter(agent, where)).pipe(
          Scope.extend(threadScope),
          Effect.provide(context)
        );
        threads.unshift(thread);
        yield* show(thread);
        return thread;
      });

    const find = (threadId: string) => Option.fromNullable(threads.find((thread) => thread.info.id === threadId));

    return {
      get current() {
        return current;
      },
      list: () => [...threads],
      connect: (post) =>
        serial(
          Effect.suspend(() => {
            if (disconnected.has(post)) {
              return Effect.void;
            }
            connected = post;
            return current ? show(current) : Effect.asVoid(create());
          })
        ),
      disconnect: (post) =>
        serial(
          Effect.suspend(() => {
            disconnected.add(post);
            if (connected !== post) {
              return Effect.void;
            }
            connected = undefined;
            return Effect.zipRight(stopBranchWatch, current ? current.detach() : Effect.void);
          })
        ),
      create: (agent) => serial(create(agent)),
      select: (threadId) =>
        serial(
          Option.match(find(threadId), {
            onNone: () => Effect.logWarning(`No thread ${threadId} to show`),
            onSome: show,
          })
        ),
      prompt: (threadId, text) =>
        Option.match(find(threadId), {
          onNone: () => Effect.logWarning(`Ignored a prompt for unknown thread ${threadId}`),
          onSome: (thread) => thread.prompt(text),
        }),
    };
  });
}
