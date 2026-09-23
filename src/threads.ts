import { Effect, ExecutionStrategy, Exit, Option, Scope } from 'effect';
import { RESUME_FAILED, type MakeAdapter } from './agents/adapter';
import { DEFAULT_MODE, type AgentKind, type Mode } from './agents/events';
import { Branches } from './branches';
import { FullAutoOptIn } from './fullAutoOptIn';
import { Ids } from './ids';
import { makeThread, type Post, type PromptAdmission, type Thread, type Workspace } from './thread';
import type { PromptRejection } from './protocol';
import { ThreadStore, type StoredThread } from './threadStore';
import { Worktrees, type GitFailed, type Worktree, type WorktreeReview, type WorktreeSetupFailed } from './worktrees';

export type PromptOutcome = { readonly status: 'accepted' } | { readonly status: 'rejected'; readonly reason: PromptRejection };

/**
 * The window's threads and the one the sidebar shows. The sidebar webview connects when it loads
 * and disconnects when VS Code disposes it (the view hidden or collapsed); the threads and their
 * agents keep running in between, so reopening the sidebar replays the shown thread.
 *
 * Threads are stored from their first prompt (see `ThreadStore`), so they outlive the window: the
 * stored ones are restored when this is made, without starting their agents, and each resumes its
 * native session with its next prompt. Archived threads are kept in the store but not in the window.
 */
export interface Threads {
  /** The thread the sidebar shows, if one has been created. */
  readonly current: Thread | undefined;
  /** Every thread in the window (none archived), newest first. */
  list(): ReadonlyArray<Thread>;
  /** The archived threads, most recently changed first. */
  archived(): ReadonlyArray<StoredThread>;
  /**
   * Connects the sidebar webview and shows it the current thread: the newest one if none has been
   * shown yet, or a new one, in the folder `Workspaces.choose` gives, if there are none. Ignored
   * for a webview already disconnected, whose connection was still queued when it closed.
   */
  connect(post: Post): Effect.Effect<void>;
  /** Disconnects the webview, if `post` is still the connected one, and stops it connecting again. */
  disconnect(post: Post): Effect.Effect<void>;
  /**
   * Shows a new thread with `agent`, by default the shown thread's agent (Claude when there is
   * none), working in `where` (by default `Workspaces.fallback`). A current thread with that
   * agent and folder that nobody has prompted yet is shown again instead.
   */
  create(agent?: AgentKind, where?: Workspace): Effect.Effect<Thread>;
  /** Creates a thread in an isolated checkout of `where`; setup must finish before it is shown. */
  createInWorktree(agent?: AgentKind, where?: Workspace): Effect.Effect<Thread, GitFailed | WorktreeSetupFailed>;
  /** Reports what the worktree of the thread with this ID has changed, if it has a worktree. */
  reviewWorktree(threadId: string): Effect.Effect<WorktreeReview | undefined, GitFailed>;
  /** The worktree of the thread with this ID, archived or not, if it has one. */
  worktreeOf(threadId: string): Worktree | undefined;
  /** Shows the thread with this ID; unknown IDs are ignored. */
  select(threadId: string): Effect.Effect<void>;
  /**
   * Archives the thread with this ID: stops its agent and takes it out of the window, keeping it
   * stored. A thread nobody has prompted has nothing to keep, so it is simply closed, unless it
   * has a worktree, which is kept like any stored thread. If it was shown, the next thread is
   * shown instead.
   */
  archive(threadId: string): Effect.Effect<void>;
  /** Brings an archived thread back into the window and shows it; it resumes with its next prompt. */
  unarchive(threadId: string): Effect.Effect<void>;
  /**
   * Deletes the thread with this ID, archived or not: stops its agent and removes it from the store.
   * A worktree thread's checkout is removed too, and its branch if `discardBranch`. The agent's own
   * session files are left alone. Succeeds with whether there was such a thread. If git cannot
   * remove the checkout, the thread is kept, archived, so Delete can be tried again.
   */
  remove(threadId: string, discardBranch?: boolean): Effect.Effect<boolean, GitFailed>;
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

/** Where new threads work. */
export interface Workspaces {
  /** The folder for a thread whose caller names none, read when the thread is created. */
  readonly fallback: () => Workspace;
  /**
   * Asks where a thread the sidebar opens by itself works (when it has none to show), as New
   * Thread would; none if the user declines, in which case no thread is created.
   */
  readonly choose: Effect.Effect<Option.Option<Workspace>>;
}

/** Why a restored worktree thread is read-only when its checkout has gone. */
export function worktreeMissing(worktree: Worktree): string {
  return `Its worktree checkout at ${worktree.path} is gone. ${RESUME_FAILED}`;
}

/**
 * @param workspaces Where a new thread's agent runs.
 * @param makeAdapter Builds the adapter for a thread with the given agent, running in the given workspace.
 * @param onChanged Told whenever any thread has seen an event, so views of the whole list can catch up.
 */
export function makeThreads<R>(
  workspaces: Workspaces,
  makeAdapter: (agent: AgentKind, workspace: Workspace) => MakeAdapter<R>,
  onChanged: () => Effect.Effect<void> = () => Effect.void
): Effect.Effect<Threads, never, R | Ids | Branches | FullAutoOptIn | Worktrees | ThreadStore | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const ids = yield* Ids;
    const branches = yield* Branches;
    const fullAuto = yield* FullAutoOptIn;
    const checkouts = yield* Worktrees;
    const store = yield* ThreadStore;
    const context = yield* Effect.context<R>();
    // Serialises everything that changes which thread is shown or connected, since VS Code
    // callbacks can start them concurrently.
    const lock = yield* Effect.makeSemaphore(1);
    const serial = lock.withPermits(1);

    const threads: Thread[] = [];
    let archived: ReadonlyArray<StoredThread> = [];
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

    const recordFor = (id: string, agent: AgentKind, location: Workspace) =>
      store.record({ id, agent, workspace: location, worktree: worktrees.get(id) });

    const openThread = (id: string, agent: AgentKind, where: Workspace, threadScope: Scope.CloseableScope, checkout?: Worktree) =>
      Effect.gen(function* () {
        const location = checkout ? { cwd: checkout.path, name: `${where.name ?? 'Workspace'} · worktree` } : where;
        if (checkout) {
          worktrees.set(id, checkout);
        }
        // A worktree thread has a checkout on disk from the start, so it is kept from the start:
        // otherwise nothing would lead back to the checkout after a reload or an archive.
        const thread = yield* makeThread(id, location, makeAdapter(agent, location), { onChanged, record: recordFor(id, agent, location), keep: checkout !== undefined })
          .pipe(Scope.extend(threadScope), Effect.provide(context));
        threadScopes.set(id, threadScope);
        threads.unshift(thread);
        yield* show(thread);
        return thread;
      });

    /** Brings a stored thread back into the window, without starting its agent. */
    const restore = (entry: StoredThread) =>
      Effect.gen(function* () {
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        if (entry.worktree) {
          worktrees.set(entry.id, entry.worktree);
        }
        const checkoutGone = entry.worktree !== undefined && !(yield* checkouts.exists(entry.worktree));
        // Full auto only comes back while the workspace still allows it.
        const mode = entry.mode === 'full_auto' && !(yield* fullAuto.granted) ? DEFAULT_MODE : entry.mode;
        const thread = yield* makeThread(entry.id, entry.workspace, makeAdapter(entry.agent, entry.workspace), {
          onChanged,
          model: entry.model,
          mode,
          record: recordFor(entry.id, entry.agent, entry.workspace),
          restored: {
            agent: entry.agent,
            sessionId: entry.sessionId,
            title: entry.title,
            readOnly: entry.readOnly ?? (checkoutGone && entry.worktree ? worktreeMissing(entry.worktree) : undefined),
            history: store.history(entry.id),
          },
        }).pipe(Scope.extend(threadScope), Effect.provide(context));
        threadScopes.set(entry.id, threadScope);
        return thread;
      });

    /**
     * Takes a thread out of the window and stops its agent. If it was shown, the next thread is
     * shown instead, or a new one while a webview is connected and none is left.
     */
    const drop = (thread: Thread) =>
      Effect.gen(function* () {
        const shown = current === thread;
        if (shown) {
          yield* thread.detach();
          current = undefined;
          yield* stopBranchWatch;
        }
        const index = threads.indexOf(thread);
        if (index !== -1) {
          threads.splice(index, 1);
        }
        const threadScope = threadScopes.get(thread.info.id);
        threadScopes.delete(thread.info.id);
        if (threadScope) {
          yield* Scope.close(threadScope, Exit.void);
        }
        if (shown) {
          const next = threads[0];
          if (next) {
            yield* show(next);
          } else if (connected) {
            yield* createChosen;
          }
        }
        yield* onChanged();
      });

    const refreshArchived = Effect.map(store.list, (all) => {
      archived = all.filter((entry) => entry.archived);
    });
    /** Files a stored thread, already out of the window, under the archived ones. */
    const keepArchived = (threadId: string) =>
      Effect.all([store.setArchived(threadId, true), refreshArchived, onChanged()], { discard: true });

    for (const entry of yield* store.load) {
      if (entry.archived) {
        archived = [...archived, entry];
      } else {
        threads.push(yield* restore(entry));
      }
    }

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
      const next = yield* makeThread(threadId, old.workspace, makeAdapter(agent, old.workspace), {
        onChanged,
        mode: old.mode,
        record: recordFor(threadId, agent, old.workspace),
      }).pipe(Scope.extend(nextScope), Effect.provide(context));
      yield* old.detach();
      threadScopes.set(threadId, nextScope);
      threads.splice(threads.indexOf(old), 1, next);
      yield* show(next);
      yield* Scope.close(oldScope, Exit.void);
    }));

    const create = (agent = current?.info.agent ?? DEFAULT_AGENT, where = workspaces.fallback()) =>
      Effect.gen(function* () {
        if (current?.isEmpty && current.info.agent === agent && current.workspace.cwd === where.cwd) {
          return current;
        }
        const id = yield* ids.next;
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        return yield* openThread(id, agent, where, threadScope);
      });

    // The sidebar has nothing to show: a new thread, in the folder the user chooses.
    const createChosen = Effect.flatMap(workspaces.choose, Option.match({
      onNone: () => Effect.void,
      onSome: (where) => Effect.asVoid(create(undefined, where)),
    }));

    const createInWorktree = (agent = current?.info.agent ?? DEFAULT_AGENT, where = workspaces.fallback()) =>
      Effect.gen(function* () {
        const id = yield* ids.next;
        const threadScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        return yield* Effect.gen(function* () {
          const checkout = yield* checkouts.create(where.cwd, id);
          return yield* openThread(id, agent, where, threadScope, checkout);
        }).pipe(Effect.onError(() => Scope.close(threadScope, Exit.void)));
      });

    const remove = (threadId: string, discardBranch = false) =>
      serial(Effect.gen(function* () {
        const live = threads.find((thread) => thread.info.id === threadId);
        const entry = archived.find((candidate) => candidate.id === threadId);
        if (!live && !entry) {
          return false;
        }
        const checkout = checkoutOf(threadId);
        // Its agent is stopped first, so nothing is running in the checkout git removes.
        if (live) {
          yield* drop(live);
        }
        // The checkout goes before the thread's record: if git fails, the thread stays archived,
        // which keeps the checkout reachable for another Delete, and the failure is reported.
        if (checkout) {
          yield* checkouts.remove(checkout, discardBranch).pipe(
            Effect.tapError(() => (live ? keepArchived(threadId) : Effect.void))
          );
        }
        worktrees.delete(threadId);
        yield* store.remove(threadId);
        archived = archived.filter((candidate) => candidate.id !== threadId);
        yield* onChanged();
        return true;
      }));

    const find = (threadId: string) => Option.fromNullable(threads.find((thread) => thread.info.id === threadId));
    /** The worktree of a thread in the window or archived. */
    const checkoutOf = (threadId: string) => worktrees.get(threadId) ?? archived.find((entry) => entry.id === threadId)?.worktree;
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
      archived: () => archived,
      connect: (post) =>
        serial(
          Effect.suspend(() => {
            if (disconnected.has(post)) {
              return Effect.void;
            }
            connected = post;
            const shown = current ?? threads[0];
            return shown ? show(shown) : createChosen;
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
      create: (agent, where) => serial(create(agent, where)),
      createInWorktree: (agent, where) => serial(createInWorktree(agent, where)),
      reviewWorktree: (threadId) => Effect.suspend(() => {
        const checkout = checkoutOf(threadId);
        return checkout ? checkouts.review(checkout) : Effect.succeed(undefined);
      }),
      worktreeOf: checkoutOf,
      select: (threadId) =>
        serial(
          Option.match(find(threadId), {
            onNone: () => Effect.logWarning(`No thread ${threadId} to show`),
            onSome: show,
          })
        ),
      archive: (threadId) =>
        serial(
          Option.match(find(threadId), {
            onNone: () => Effect.logWarning(`No thread ${threadId} to archive`),
            onSome: (thread) =>
              Effect.gen(function* () {
                yield* drop(thread);
                // An unprompted thread has nothing stored to keep, unless it has a worktree.
                if (thread.isEmpty && !worktrees.has(threadId)) {
                  return;
                }
                yield* keepArchived(threadId);
              }),
          })
        ),
      unarchive: (threadId) =>
        serial(
          Effect.gen(function* () {
            const entry = archived.find((candidate) => candidate.id === threadId);
            if (!entry) {
              return yield* Effect.logWarning(`No archived thread ${threadId} to bring back`);
            }
            yield* store.setArchived(threadId, false);
            archived = archived.filter((candidate) => candidate !== entry);
            const thread = yield* restore(entry);
            threads.unshift(thread);
            yield* show(thread);
            yield* onChanged();
          })
        ),
      remove,
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
