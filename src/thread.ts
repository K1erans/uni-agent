import { Effect, type Scope } from 'effect';
import type { MakeAdapter } from './agents/adapter';
import type { AgentEvent } from './agents/events';
import type { ExtensionMessage, WebviewMessage } from './protocol';

/**
 * One conversation with one agent. Keeps every event the adapter emits so a webview that (re)loads
 * — a hidden tab coming back, a reload — is brought up to date by replaying them. The thread and
 * its adapter live in the scope that makes them; closing it stops the agent.
 */
export interface Thread {
  /** Connects a freshly loaded webview, replacing any previous one. */
  attach(post: (message: ExtensionMessage) => Effect.Effect<void>): Effect.Effect<void>;
  handle(message: WebviewMessage): Effect.Effect<void>;
}

export function makeThread<R>(makeAdapter: MakeAdapter<R>): Effect.Effect<Thread, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const history: AgentEvent[] = [];
    let post: ((message: ExtensionMessage) => Effect.Effect<void>) | undefined;
    let running = false;

    const adapter = yield* makeAdapter((event) =>
      Effect.suspend(() => {
        if (event.type === 'turn_started' || event.type === 'turn_ended') {
          running = event.type === 'turn_started';
        }
        history.push(event);
        return post ? post({ type: 'event', event }) : Effect.void;
      })
    );
    // Finalizers run in reverse, so this runs before the adapter stops and its last events are not
    // posted to a closed webview.
    yield* Effect.addFinalizer(() => Effect.sync(() => (post = undefined)));

    return {
      attach: (next) =>
        Effect.suspend(() => {
          post = next;
          return next({ type: 'history', events: [...history] });
        }),
      handle: (message) =>
        Effect.suspend(() => {
          if (message.type !== 'prompt' || !message.text.trim() || running) {
            return Effect.void;
          }
          // The turn runs on its own fiber, which starts after this returns, so mark it running now
          // rather than on `turn_started`; a prompt arriving meanwhile is then ignored too.
          running = true;
          return adapter.prompt([{ type: 'text', text: message.text }]).pipe(
            // The running check above means the adapter never sees a second prompt mid-turn.
            Effect.orDie,
            Effect.forkIn(scope),
            Effect.asVoid
          );
        }),
    };
  });
}
