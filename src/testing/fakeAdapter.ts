import { Effect } from 'effect';
import type { AgentAdapter, EventSink, MakeAdapter } from '../agents/adapter';
import type { ContentBlock, StopReason } from '../agents/events';

/** An adapter for tests whose turns run until the test ends them. */
export class FakeAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly prompts: ReadonlyArray<ContentBlock>[] = [];
  disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly onEvent: EventSink
  ) {}

  /** Builds fake adapters, recording each one in `made`, announcing sessions like real adapters do. */
  static maker(made: FakeAdapter[]): MakeAdapter<never> {
    return (onEvent) =>
      Effect.gen(function* () {
        const fake = new FakeAdapter(`session-${made.length + 1}`, onEvent);
        yield* onEvent({ type: 'session_started', agent: 'claude', sessionId: fake.sessionId });
        yield* Effect.addFinalizer(() => Effect.sync(() => (fake.disposed = true)));
        made.push(fake);
        return fake;
      });
  }

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
