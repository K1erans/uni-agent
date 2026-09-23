import { Clock, Effect, Scope } from 'effect';
import { RESUME_FAILED, type AgentAdapter, type EventSink, type MakeAdapter } from './agents/adapter';
import { AGENT_NAMES, DEFAULT_MODE, MODE_NAMES, type AgentKind, type Mode } from './agents/events';
import { Compactor, type CompactedEvent } from './compaction';
import { threadTitle, type ExtensionMessage, type ThreadEvent, type ThreadInfo } from './protocol';

/** Where a thread's agent runs. */
export interface Workspace {
  readonly cwd: string;
  /** The workspace folder's name; null when no folder is open and the agent runs in the home directory. */
  readonly name: string | null;
}

/** Delivers a message to the connected webview. */
export type Post = (message: ExtensionMessage) => Effect.Effect<void>;

/** Why a thread refused a prompt. */
export type PromptRefusal = 'busy' | 'empty' | 'read_only';

export type PromptAdmission = { readonly status: 'accepted' } | { readonly status: 'rejected'; readonly reason: PromptRefusal };

/** How a thread is doing, for lists of threads. */
export type ThreadStatus = 'running' | 'needs_approval' | 'idle' | 'read_only';

/** What a thread says once some of its stored history cannot be read. */
export const HISTORY_UNREADABLE = 'Some of this thread’s history couldn’t be read, so it is read-only. Start a new thread to go on.';

/** What a thread knows about itself that a restored thread starts from; everything but its transcript. */
export interface ThreadFacts {
  /** The first prompt's title; undefined until the first prompt. */
  readonly title: string | undefined;
  /** The native session to resume; undefined until the agent has opened one. */
  readonly sessionId: string | undefined;
  readonly mode: Mode;
  readonly model: string | undefined;
  /** Why the thread takes no more prompts, if it does not. */
  readonly readOnly: string | undefined;
}

/**
 * Where a thread keeps itself, so it outlives the window: its facts, and its transcript as rows
 * of finished items (see `Compactor`). The thread decides when there is something worth keeping
 * and calls it then. A record never fails: what it cannot keep, it logs.
 */
export interface ThreadRecord {
  /** Keeps the thread's facts as they now stand; the first call stores the thread. */
  save(facts: ThreadFacts): Effect.Effect<void>;
  /** Adds finished transcript rows, in the order they replay; only called once the thread is saved. */
  append(rows: ReadonlyArray<CompactedEvent>): Effect.Effect<void>;
}

/** A record that keeps nothing, for threads that are not stored. */
export const NO_RECORD: ThreadRecord = { save: () => Effect.void, append: () => Effect.void };

/** A stored thread's transcript, in the order it happened. */
export interface StoredHistory {
  readonly events: ReadonlyArray<ThreadEvent>;
  /** False if some rows could not be read; they are left out of `events`. */
  readonly complete: boolean;
  /** The first row position not yet used, where the thread's next rows go. */
  readonly nextSeq: number;
}

/**
 * A stored thread brought back after a reload. Its history is loaded when it is first shown or
 * prompted, and its agent is started by its next prompt, which resumes the stored session.
 */
export interface RestoredThread {
  readonly agent: AgentKind;
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  /** Why the thread is read-only, if it already is. */
  readonly readOnly: string | undefined;
  readonly history: Effect.Effect<StoredHistory>;
}

export interface ThreadOptions {
  /**
   * Told whenever the thread has seen an event or changed status, so a view outside the webview
   * (the thread list, the sidebar's badge) can catch up with, for example, a thread waiting for approval.
   */
  readonly onChanged?: () => Effect.Effect<void>;
  readonly model?: string;
  /** The mode the thread starts in; {@link DEFAULT_MODE} if left out. */
  readonly mode?: Mode;
  readonly record?: ThreadRecord;
  /**
   * Whether the thread has something to keep before its first prompt (a worktree thread's
   * checkout), so it is saved at once rather than when its first prompt is admitted.
   */
  readonly keep?: boolean;
  readonly restored?: RestoredThread;
}

/**
 * One conversation with one agent. Keeps every event the adapter emits, stamped with when it
 * arrived, so a webview that (re)loads or switches to this thread is brought up to date by
 * replaying them. From its first prompt it keeps itself in its record: its facts whenever they
 * change, and each transcript item once it has finished. The thread and its adapter live in the
 * scope that makes them; closing it stops the agent.
 */
export interface Thread {
  readonly info: ThreadInfo;
  readonly workspace: Workspace;
  /** The first prompt's title; undefined until the first prompt. */
  readonly title: string | undefined;
  /** Whether no prompt has been sent yet. */
  readonly isEmpty: boolean;
  /** Whether the agent is waiting for the user to answer a permission request. */
  readonly needsApproval: boolean;
  readonly status: ThreadStatus;
  /** Why the thread takes no more prompts, if it does not. */
  readonly readOnly: string | undefined;
  /** How freely the agent may act; new threads start in {@link DEFAULT_MODE}. */
  readonly mode: Mode;
  readonly selectedModel: string | undefined;
  /** Connects a webview, replacing any previous one, and sends it the history so far. */
  attach(post: Post): Effect.Effect<void>;
  /** Stops forwarding events to the connected webview. */
  detach(): Effect.Effect<void>;
  /** Reserves a turn immediately and reports whether the prompt was admitted. */
  prompt(text: string): Effect.Effect<PromptAdmission>;
  /** Stops the running turn. */
  cancel(): Effect.Effect<void>;
  /** Answers a permission request the agent is waiting on; an answer it cannot place is logged and dropped. */
  respond(requestId: string, optionId: string): Effect.Effect<void>;
  /**
   * Switches the thread's mode, including mid-turn, and tells the connected webview. If the agent
   * refuses, the thread keeps its mode and logs why. Checking Full auto is allowed is the caller's job.
   */
  setMode(mode: Mode): Effect.Effect<void>;
  /** Changes the selected model between prompts, keeping the provider and session. */
  setModel(model: string | undefined): Effect.Effect<void>;
}

/**
 * The permission requests a thread's events leave open: those announced and not resolved since.
 * Adapters resolve every request before their turn ends, so this is empty between turns.
 */
export function openApprovals(events: ReadonlyArray<ThreadEvent>): ReadonlySet<string> {
  const open = new Set<string>();
  for (const { event } of events) {
    if (event.type === 'permission_request') {
      open.add(event.requestId);
    } else if (event.type === 'permission_resolved') {
      open.delete(event.requestId);
    }
  }
  return open;
}

/**
 * Makes a thread. A new one starts its adapter now (which starts no process until the first
 * prompt); a restored one leaves it until its next prompt, so showing it starts nothing.
 */
export function makeThread<R>(
  id: string,
  workspace: Workspace,
  makeAdapter: MakeAdapter<R>,
  options: ThreadOptions = {}
): Effect.Effect<Thread, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const { onChanged = () => Effect.void, record = NO_RECORD, restored } = options;
    const history: ThreadEvent[] = [];
    let post: Post | undefined;
    let adapter: AgentAdapter | undefined;
    let running = false;
    let prompted = restored !== undefined;
    let title = restored?.title;
    let mode = options.mode ?? DEFAULT_MODE;
    let sessionId = restored?.sessionId;
    let selectedModel = options.model;
    let readOnly = restored?.readOnly;
    // Whether the thread is in its record: from its first prompt, or from the start if it has
    // something to keep already. A restored thread is stored by definition.
    let stored = restored !== undefined;
    // Turns live events into rows of finished items; a restored thread's starts after its stored rows.
    let compactor = restored ? undefined : new Compactor(0);
    // Mode changes arrive on fibers of their own; one at a time keeps the mode shown in step with
    // the one the agent runs in.
    const modeLock = yield* Effect.makeSemaphore(1);

    /** Saves the thread's facts, once it is stored. */
    const save = Effect.suspend(() =>
      stored ? record.save({ title, sessionId, mode, model: selectedModel, readOnly }) : Effect.void
    );

    const becomeReadOnly = (reason: string) =>
      Effect.suspend(() => {
        if (readOnly !== undefined) {
          return Effect.void;
        }
        readOnly = reason;
        return Effect.all([save, post ? post({ type: 'read_only', threadId: id, reason }) : Effect.void, onChanged()], { discard: true });
      });

    const sink: EventSink = (event) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => {
        const sessionOpened = event.type === 'session_started' && event.sessionId !== sessionId;
        if (event.type === 'session_started') {
          sessionId = event.sessionId;
        }
        history.push({ event, at });
        const rows = stored && compactor ? compactor.push(event, at) : [];
        return Effect.all(
          [
            sessionOpened ? save : Effect.void,
            rows.length > 0 ? record.append(rows) : Effect.void,
            post ? post({ type: 'event', threadId: id, event, at }) : Effect.void,
            onChanged(),
            event.type === 'error' && event.code === 'resume_failed' ? becomeReadOnly(RESUME_FAILED) : Effect.void,
          ],
          { discard: true }
        );
      });

    // Made once, when first needed. It lives in the thread's scope; the finalizer added after it
    // runs first, so the adapter's last events are not posted to a closed webview.
    const adapterFor = yield* Effect.cached(
      Effect.suspend(() => makeAdapter(sink, mode, selectedModel, sessionId)).pipe(
        Effect.tap((made) => Effect.zipRight(Effect.sync(() => (adapter = made)), Effect.addFinalizer(() => Effect.sync(() => (post = undefined))))),
        Scope.extend(scope),
        Effect.provide(context)
      )
    );
    // A restored thread's history is read from the store once, before it is first shown or prompted.
    const loaded = yield* Effect.cached(
      restored
        ? Effect.flatMap(restored.history, ({ events, complete, nextSeq }) => {
            history.splice(0, 0, ...events);
            compactor = new Compactor(nextSeq);
            return complete ? Effect.void : becomeReadOnly(HISTORY_UNREADABLE);
          })
        : Effect.void
    );
    const agent = restored ? restored.agent : (yield* adapterFor).agent;
    if (options.keep) {
      stored = true;
      yield* save;
    }

    const info: ThreadInfo = { id, agent, workspace: workspace.name };
    // History is loaded before a prompt is admitted: loading can find it unreadable, which makes
    // the thread read-only, and a prompt admitted before then would still reach the agent.
    const prompt = (text: string): Effect.Effect<PromptAdmission> =>
      Effect.zipRight(loaded, Effect.suspend((): Effect.Effect<PromptAdmission> => {
        if (!text.trim()) {
          return Effect.succeed({ status: 'rejected' as const, reason: 'empty' as const });
        }
        if (running) {
          return Effect.succeed({ status: 'rejected' as const, reason: 'busy' as const });
        }
        if (readOnly !== undefined) {
          return Effect.succeed({ status: 'rejected' as const, reason: 'read_only' as const });
        }
        running = true;
        prompted = true;
        title ??= threadTitle(text);
        stored = true;
        const turn = Effect.gen(function* () {
          const started = yield* adapterFor;
          yield* Effect.orDie(started.prompt([{ type: 'text', text }]));
        }).pipe(Effect.ensuring(Effect.sync(() => { running = false; })));
        // The thread is saved, with its title and any session already open, before its first row.
        return Effect.zipRight(save, Effect.as(Effect.forkIn(turn, scope), { status: 'accepted' } as const));
      }));
    const showMode = (next: Mode) =>
      Effect.suspend(() => {
        mode = next;
        return Effect.zipRight(save, post ? post({ type: 'mode', threadId: id, mode: next }) : Effect.void);
      });
    return {
      info,
      workspace,
      get title() {
        return title;
      },
      get isEmpty() {
        return !prompted;
      },
      get needsApproval() {
        return openApprovals(history).size > 0;
      },
      get status(): ThreadStatus {
        if (openApprovals(history).size > 0) {
          return 'needs_approval';
        }
        if (running) {
          return 'running';
        }
        return readOnly === undefined ? 'idle' : 'read_only';
      },
      get readOnly() {
        return readOnly;
      },
      get mode() {
        return mode;
      },
      get selectedModel() {
        return selectedModel;
      },
      attach: (next) =>
        Effect.zipRight(
          loaded,
          Effect.suspend(() => {
            post = next;
            return next({ type: 'history', thread: info, mode, model: selectedModel ?? null, readOnly: readOnly ?? null, events: [...history] });
          })
        ),
      detach: () => Effect.sync(() => (post = undefined)),
      prompt,
      cancel: () => Effect.suspend(() => (adapter ? adapter.cancel() : Effect.void)),
      respond: (requestId, optionId) =>
        Effect.suspend(() => {
          if (!adapter) {
            return Effect.logDebug(`Ignored an answer for permission request ${requestId} of thread ${id}, whose agent has not started`);
          }
          // An answer for a request that is no longer open (the turn ended, or a second click) is
          // nothing to act on, and never a reason to break the thread.
          return Effect.catchTag(adapter.respond(requestId, optionId), 'UnknownPermissionRequest', (error) =>
            Effect.logDebug(`Ignored an answer for permission request ${error.requestId} of thread ${id}`)
          );
        }),
      setMode: (next) =>
        modeLock.withPermits(1)(
          Effect.suspend(() => {
            // An agent not started yet starts in whatever mode the thread has by then.
            if (!adapter) {
              return showMode(next);
            }
            return adapter.setMode(next).pipe(
              // Only a switch the agent accepted is shown: the webview must never show a stricter mode
              // than the agent really runs in.
              Effect.zipRight(showMode(next)),
              Effect.catchTag('ModeChangeFailed', (error) =>
                Effect.logWarning(`${AGENT_NAMES[error.agent]} refused to switch thread ${id} to ${MODE_NAMES[error.mode]}; it keeps ${MODE_NAMES[mode]}: ${error.reason}`)
              )
            );
          })
        ),
      setModel: (next) => Effect.gen(function* () {
        if (running) {
          return;
        }
        if (adapter) {
          const changed = yield* Effect.either(adapter.setModel(next));
          if (changed._tag === 'Left') {
            yield* Effect.logWarning(`${AGENT_NAMES[agent]} refused the model change: ${changed.left.reason}`);
            return;
          }
        }
        selectedModel = next;
        yield* save;
        if (post) {
          yield* post({ type: 'model', threadId: id, model: next ?? null });
        }
      }),
    };
  });
}
