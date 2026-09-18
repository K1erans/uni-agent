import { Effect, Exit, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, EventSink } from './agents/adapter';
import type { ContentBlock, StopReason } from './agents/events';
import type { ExtensionMessage, WebviewMessage } from './protocol';
import { makeThread } from './thread';

/** An adapter whose turns run until the test ends them. */
class FakeAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly sessionId = 'session-1';
  readonly prompts: ReadonlyArray<ContentBlock>[] = [];
  disposed = false;

  constructor(private readonly onEvent: EventSink) {}

  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason> {
    return Effect.andThen(
      Effect.suspend(() => {
        this.prompts.push(prompt);
        return this.onEvent({ type: 'turn_started', turnId: `turn-${this.prompts.length}`, prompt });
      }),
      Effect.never
    );
  }

  cancel(): Effect.Effect<void> {
    return Effect.void;
  }

  endTurn(): Promise<void> {
    return Effect.runPromise(this.onEvent({ type: 'turn_ended', turnId: `turn-${this.prompts.length}`, stopReason: 'end_turn' }));
  }
}

/** Opens a thread over a fake adapter; `handle` lets forked turns start before it returns. */
function setup() {
  let adapter: FakeAdapter | undefined;
  const scope = Effect.runSync(Scope.make());
  const thread = Effect.runSync(
    makeThread((onEvent) =>
      Effect.gen(function* () {
        const fake = new FakeAdapter(onEvent);
        yield* onEvent({ type: 'session_started', agent: 'claude', sessionId: fake.sessionId });
        yield* Effect.addFinalizer(() => Effect.sync(() => (fake.disposed = true)));
        adapter = fake;
        return fake;
      })
    ).pipe(Scope.extend(scope))
  );
  return {
    adapter: adapter!,
    attach: (post: (message: ExtensionMessage) => void) => Effect.runSync(thread.attach((message) => Effect.sync(() => post(message)))),
    handle: (message: WebviewMessage) => Effect.runPromise(Effect.andThen(thread.handle(message), Effect.yieldNow())),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

describe('Thread', () => {
  it('replays its history to every webview that attaches, then forwards new events', async () => {
    const { adapter, attach, handle } = setup();
    const first = vi.fn();
    attach(first);
    await handle({ type: 'prompt', text: 'hi' });

    // A reloaded webview gets everything so far in one message.
    const second = vi.fn();
    attach(second);
    expect(second).toHaveBeenCalledWith({
      type: 'history',
      events: [expect.objectContaining({ type: 'session_started' }), expect.objectContaining({ type: 'turn_started' })],
    });

    await adapter.endTurn();
    expect(second).toHaveBeenLastCalledWith({ type: 'event', event: expect.objectContaining({ type: 'turn_ended' }) });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('ignores prompts while a turn is running and blank prompts', async () => {
    const { adapter, handle } = setup();

    await handle({ type: 'prompt', text: '   ' });
    // Sent back to back, before the first turn's fiber has started.
    await Promise.all([handle({ type: 'prompt', text: 'one' }), handle({ type: 'prompt', text: 'two' })]);
    await adapter.endTurn();
    await handle({ type: 'prompt', text: 'three' });

    expect(adapter.prompts.map(([block]) => block.text)).toEqual(['one', 'three']);
  });

  it('stops the adapter when its scope closes', async () => {
    const { adapter, close } = setup();
    await close();
    expect(adapter.disposed).toBe(true);
  });
});
