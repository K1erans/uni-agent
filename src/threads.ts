import { Effect, Either, ExecutionStrategy, Exit, Option, Scope } from 'effect';
import type { MakeAdapter } from './agents/adapter';
import type { AgentKind, Mode } from './agents/events';
import { Branches } from './branches';
import { FullAutoOptIn } from './fullAutoOptIn';
import { Ids } from './ids';
import { makeThread, type Post, type PromptAdmission, type Thread, type Workspace } from './thread';
import type { PromptRejection } from './protocol';
import { GitFailed, GitRunner, inspectWorktree, prepareWorktree, removeWorktree, type Worktree, type WorktreeSetupFailed } from './worktrees';

export type PromptOutcome = { readonly status: 'accepted' } | { readonly status: 'rejected'; readonly reason: PromptRejection };

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
  /** Creates a thread in an isolated checkout; setup must finish before it is shown. */
  createInWorktree(agent?: AgentKind): Effect.Effect<Thread, GitFailed | WorktreeSetupFailed>;
  /** Reports the shown worktree's changes, if the shown thread has one. */
  reviewCurrentWorktree(): Effect.Effect<{ readonly worktree: Worktree; readonly status: string; readonly diffStat: string } | undefined, GitFailed>;
  /** Stops and removes the shown worktree thread; optionally discards its branch. */
  removeCurrentWorktree(discardBranch: boolean): Effect.Effect<boolean, GitFailed>;
  /** Shows the thread with this ID; unknown IDs are ignored. */
  select(threadId: string): Effect.Effect<void>;
  /** Sends an intentional background prompt to a thread, shown or not. */
  prompt(threadId: string, text: string): Effect.Effect<PromptOutcome>;
  /** Admits a sidebar prompt only while that webview still shows its named thread. */
  submitSidebar(post: Post, threadId: string, text: string): Effect.Effect<PromptOutcome>;
  /** Answers a permission request in the thread with this ID, whether or not it is shown. */
  respond(threadId: string, requestId: string, optionId: string): Effect.Effect<void>;
  /**
   * Switches the thread with this ID to `mode`. Full auto is refused until the workspace has opted
   * in, so the thread keeps its mode and the webview keeps showing it.
   */
  setMode(threadId: string, mode: Mode): Effect.Effect<void>;
  /** Changes an empty thread's agent in place; accepted prompts lock the agent. */
  setAgent(threadId: string, agent: AgentKind): Effect.Effect<void>;
  /** Changes a thread's selected model between prompts. */
  setModel(threadId: string, model: string | undefined): Effect.Effect<void>;
}

/** The agent a thread talks to when nothing chose one. */
const DEFAULT_AGENT: AgentKind = 'claude';

/**
 * @param workspace Where a new thread's agent runs, read when the thread is created.
 * @param makeAdapter Builds the adapter for a thread with the given agent, running in the given workspace.
 * @param onChanged Told whenever any thread has seen an event, so views of the whole list can catch up.
 */
export function makeThreads<R>(
  workspace: () => Workspace,
  makeAdapter: (agent: AgentKind, workspace: Workspace) => MakeAdapter<R>,
  onChanged: () => Effect.Effect<void> = () => Effect.void,
  worktreeConfig?: { readonly storagePath: string; readonly setupCommand: (workspace: Workspace) => string | undefined }
): Effect.Effect<Threads, never, R | Ids | Branches | FullAutoOptIn | GitRunner | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const ids = yield* Ids;
    const branches = yield* Branches;
    const fullAuto = yield* FullAutoOptIn;
    const git = yield* GitRunner;
    const context = yield* Effect.context<R>();
    // Serialises everything that changes which thread is shown or connected, since VS Code
    // callbacks can start them concurrently.
    const lock = yield* Effect.makeSemaphore(1);
    const serial = lock.withPermits(1);

    const threads: Thread[] = [];
    const worktrees = new Map<string, Worktree>();
    const threadScopes = new Map<string, Scope.CloseableScope>();
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

    const openThread = (id: string, agent: AgentKind, where: Workspace, threadScope: Scope.CloseableScope, checkout?: Worktree) =>
      Effect.gen(function* () {
        const location = checkout ? { cwd: checkout.path, name: `${where.name ?? 'Workspace'} · worktree` } : where;
        const thread = yield* makeThread(id, location, makeAdapter(agent, location), onChanged).pipe(
          Scope.extend(threadScope),
          Effect.provide(context)
        );
        if (checkout) {
          worktrees.set(id, checkout);
        }
        threadScopes.set(id, threadScope);
        threads.unshift(thread);
        yield* show(thread);
        return thread;
      });

    const setAgent = (threadId: string, agent: AgentKind) => serial(Effect.gen(function* () {
      const old = current;
      if (!old || old.info.id !== threadId || !old.isEmpty || old.info.agent === agent) {
        return;
      }
      const oldScope = threadScopes.get(threadId);
      if (!oldScope) {
        return;
      }
      const nextScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
      const next = yield* makeThread(threadId, old.workspace, makeAdapter(agent, old.workspace), onChanged, undefined, undefined, old.mode).pipe(
        Scope.extend(nextScope), Effect.provide(context)
      );
      yield* old.detach();
      threadScopes.set(threadId, nextScope);
      threads.splice(threads.indexOf(old), 1, next);
      yield* show(next);
      yield* Scope.close(oldScope, Exit.void);
    }));

    const create = (agent = current?.info.agent ?? DEFAULT_AGENT) =>
      Effect.gen(function* () {
        const where = workspace();
        if (current?.isEmpty && current.info.agent === agent && current.workspace.cwd === where.cwd) {
          return current;
        }
        const id = yield* ids.next;
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        return yield* openThread(id, agent, where, threadScope);
      });

    const createInWorktree = (agent = current?.info.agent ?? DEFAULT_AGENT) =>
      Effect.gen(function* () {
        if (!worktreeConfig) {
          return yield* new GitFailed({ operation: 'worktree add', reason: 'Worktree storage is not configured.' });
        }
        const where = workspace();
        const id = yield* ids.next;
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        return yield* Effect.gen(function* () {
          const checkout = yield* prepareWorktree(where.cwd, worktreeConfig.storagePath, id, worktreeConfig.setupCommand(where))
            .pipe(Effect.provideService(GitRunner, git));
          return yield* openThread(id, agent, where, threadScope, checkout);
        }).pipe(Effect.onError(() => Scope.close(threadScope, Exit.void)));
      });

    const find = (threadId: string) => Option.fromNullable(threads.find((thread) => thread.info.id === threadId));
    const outcome = (admission: PromptAdmission): PromptOutcome =>
      admission.status === 'accepted' ? { status: 'accepted' } : { status: 'rejected', reason: admission.reason };
    const prompt = (threadId: string, text: string): Effect.Effect<PromptOutcome> =>
      Option.match(find(threadId), {
        onNone: () => Effect.succeed({ status: 'rejected', reason: 'unknown' } as const),
        onSome: (thread) => Effect.map(thread.prompt(text), outcome),
      });

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
      createInWorktree: (agent) => serial(createInWorktree(agent)),
      reviewCurrentWorktree: () => Effect.suspend(() => {
        const checkout = current && worktrees.get(current.info.id);
        return checkout
          ? Effect.map(inspectWorktree(checkout).pipe(Effect.provideService(GitRunner, git)), (review) => ({ worktree: checkout, ...review }))
          : Effect.succeed(undefined);
      }),
      removeCurrentWorktree: (discardBranch) => serial(Effect.gen(function* () {
        const shown = current;
        const checkout = shown && worktrees.get(shown.info.id);
        if (!shown || !checkout) {
          return false;
        }
        yield* shown.detach();
        const threadScope = threadScopes.get(shown.info.id);
        if (threadScope) {
          yield* Scope.close(threadScope, Exit.void);
        }
        const removal = yield* removeWorktree(checkout, discardBranch).pipe(Effect.provideService(GitRunner, git), Effect.either);
        threadScopes.delete(shown.info.id);
        worktrees.delete(shown.info.id);
        threads.splice(threads.indexOf(shown), 1);
        current = undefined;
        yield* stopBranchWatch;
        const next = threads[0];
        if (next) {
          yield* show(next);
        } else if (connected) {
          yield* create();
        }
        if (Either.isLeft(removal)) {
          return yield* removal.left;
        }
        return true;
      })),
      select: (threadId) =>
        serial(
          Option.match(find(threadId), {
            onNone: () => Effect.logWarning(`No thread ${threadId} to show`),
            onSome: show,
          })
        ),
      prompt,
      submitSidebar: (post, threadId, text) => serial(Effect.suspend(() =>
        connected !== post || current?.info.id !== threadId
          ? Effect.succeed({ status: 'rejected', reason: 'stale' } as const)
          : prompt(threadId, text)
      )),
      respond: (threadId, requestId, optionId) =>
        Option.match(find(threadId), {
          onNone: () => Effect.logWarning(`Ignored an answer for unknown thread ${threadId}`),
          onSome: (thread) => thread.respond(requestId, optionId),
        }),
      setMode: (threadId, mode) =>
        Option.match(find(threadId), {
          onNone: () => Effect.logWarning(`Ignored a mode for unknown thread ${threadId}`),
          onSome: (thread) =>
            Effect.gen(function* () {
              if (mode === 'full_auto' && !(yield* fullAuto.granted)) {
                return yield* Effect.logWarning(`Kept thread ${threadId} out of Full auto: this workspace has not opted in`);
              }
              yield* thread.setMode(mode);
            }),
        }),
      setAgent,
      setModel: (threadId, model) => serial(Option.match(find(threadId), {
        onNone: () => Effect.logWarning(`Ignored a model for unknown thread ${threadId}`),
        onSome: (thread) => thread.setModel(model),
      })),
    };
  });
}
