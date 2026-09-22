import { Clock, Effect, type Scope } from 'effect';
import type { MakeAdapter } from './agents/adapter';
import { DEFAULT_MODE, type Mode } from './agents/events';
import { threadTitle, type ExtensionMessage, type ThreadEvent, type ThreadInfo } from './protocol';

/** Where a thread's agent runs. */
export interface Workspace {
  readonly cwd: string;
  /** The workspace folder's name; null when no folder is open and the agent runs in the home directory. */
  readonly name: string | null;
}

/** Delivers a message to the connected webview. */
export type Post = (message: ExtensionMessage) => Effect.Effect<void>;

/**
 * One conversation with one agent. Keeps every event the adapter emits, stamped with when it
 * arrived, so a webview that (re)loads or switches to this thread is brought up to date by
 * replaying them. The thread and its adapter live in the scope that makes them; closing it stops
 * the agent.
 */
export interface Thread {
  readonly info: ThreadInfo;
  readonly workspace: Workspace;
  /** The first prompt's title; undefined until the first turn starts. */
  readonly title: string | undefined;
  /** Whether no prompt has been sent yet. */
  readonly isEmpty: boolean;
  /** Whether the agent is waiting for the user to answer a permission request. */
  readonly needsApproval: boolean;
  /** How freely the agent may act; new threads start in {@link DEFAULT_MODE}. */
  readonly mode: Mode;
  /** Connects a webview, replacing any previous one, and sends it the history so far. */
  attach(post: Post): Effect.Effect<void>;
  /** Stops forwarding events to the connected webview. */
  detach(): Effect.Effect<void>;
  /** Starts a turn; blank prompts and prompts sent while a turn runs are ignored. */
  prompt(text: string): Effect.Effect<void>;
  /** Answers a permission request the agent is waiting on; an answer it cannot place is logged and dropped. */
  respond(requestId: string, optionId: string): Effect.Effect<void>;
  /** Switches the thread's mode, including mid-turn, and tells the connected webview. Checking Full auto is allowed is the caller's job. */
  setMode(mode: Mode): Effect.Effect<void>;
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
 * @param onChanged Told whenever the thread has seen an event, so a view outside the webview (the
 * thread list, the sidebar's badge) can catch up with, for example, a thread waiting for approval.
 */
export function makeThread<R>(
  id: string,
  workspace: Workspace,
  makeAdapter: MakeAdapter<R>,
  onChanged: () => Effect.Effect<void> = () => Effect.void
): Effect.Effect<Thread, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const history: ThreadEvent[] = [];
    let post: Post | undefined;
    let running = false;
    let prompted = false;
    let title: string | undefined;
    let mode = DEFAULT_MODE;

    const adapter = yield* makeAdapter((event) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => {
        if (event.type === 'turn_started' || event.type === 'turn_ended') {
          running = event.type === 'turn_started';
        }
        if (event.type === 'turn_started' && title === undefined) {
          title = threadTitle(event.prompt.map((block) => block.text).join('\n'));
        }
        history.push({ event, at });
        return Effect.zipRight(post ? post({ type: 'event', threadId: id, event, at }) : Effect.void, onChanged());
      }),
      mode
    );
    // Finalizers run in reverse, so this runs before the adapter stops and its last events are not
    // posted to a closed webview.
    yield* Effect.addFinalizer(() => Effect.sync(() => (post = undefined)));

    const info: ThreadInfo = { id, agent: adapter.agent, workspace: workspace.name };
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
      get mode() {
        return mode;
      },
      attach: (next) =>
        Effect.suspend(() => {
          post = next;
          return next({ type: 'history', thread: info, mode, events: [...history] });
        }),
      detach: () => Effect.sync(() => (post = undefined)),
      prompt: (text) =>
        Effect.suspend(() => {
          if (!text.trim() || running) {
            return Effect.void;
          }
          // The turn runs on its own fiber, which starts after this returns, so mark it running now
          // rather than on `turn_started`; a prompt arriving meanwhile is then ignored too.
          running = true;
          prompted = true;
          return adapter.prompt([{ type: 'text', text }]).pipe(
            // The running check above means the adapter never sees a second prompt mid-turn.
            Effect.orDie,
            Effect.forkIn(scope),
            Effect.asVoid
          );
        }),
      respond: (requestId, optionId) =>
        // An answer for a request that is no longer open (the turn ended, or a second click) is
        // nothing to act on, and never a reason to break the thread.
        Effect.catchTag(adapter.respond(requestId, optionId), 'UnknownPermissionRequest', (error) =>
          Effect.logDebug(`Ignored an answer for permission request ${error.requestId} of thread ${id}`)
        ),
      setMode: (next) =>
        Effect.suspend(() => {
          mode = next;
          return Effect.zipRight(adapter.setMode(next), post ? post({ type: 'mode', threadId: id, mode: next }) : Effect.void);
        }),
    };
  });
}
