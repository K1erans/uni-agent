import { Clock, Effect, type Scope } from 'effect';
import type { MakeAdapter } from './agents/adapter';
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
  /** Connects a webview, replacing any previous one, and sends it the history so far. */
  attach(post: Post): Effect.Effect<void>;
  /** Stops forwarding events to the connected webview. */
  detach(): Effect.Effect<void>;
  /** Starts a turn; blank prompts and prompts sent while a turn runs are ignored. */
  prompt(text: string): Effect.Effect<void>;
}

export function makeThread<R>(
  id: string,
  workspace: Workspace,
  makeAdapter: MakeAdapter<R>
): Effect.Effect<Thread, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const history: ThreadEvent[] = [];
    let post: Post | undefined;
    let running = false;
    let prompted = false;
    let title: string | undefined;

    const adapter = yield* makeAdapter((event) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => {
        if (event.type === 'turn_started' || event.type === 'turn_ended') {
          running = event.type === 'turn_started';
        }
        if (event.type === 'turn_started' && title === undefined) {
          title = threadTitle(event.prompt.map((block) => block.text).join('\n'));
        }
        history.push({ event, at });
        return post ? post({ type: 'event', threadId: id, event, at }) : Effect.void;
      })
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
      attach: (next) =>
        Effect.suspend(() => {
          post = next;
          return next({ type: 'history', thread: info, events: [...history] });
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
    };
  });
}
