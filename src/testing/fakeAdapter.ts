import { Effect } from 'effect';
import type { AgentAdapter, EventSink, MakeAdapter } from '../agents/adapter';
import { UnknownPermissionRequest } from '../agents/adapter';
import type { AgentKind, ContentBlock, StopReason } from '../agents/events';

/** An adapter for tests whose turns run until the test ends them. */
export class FakeAdapter implements AgentAdapter {
  readonly prompts: ReadonlyArray<ContentBlock>[] = [];
  /** The answers the thread routed to this adapter, as request and option IDs. */
  readonly answers: [string, string][] = [];
  disposed = false;
  private readonly requests = new Set<string>();

  constructor(
    readonly agent: AgentKind,
    readonly sessionId: string,
    private readonly onEvent: EventSink
  ) {}

  /** Builds fake adapters for `agent`, recording each one in `made`, announcing sessions like Claude's adapter does. */
  static maker(made: FakeAdapter[], agent: AgentKind = 'claude'): MakeAdapter<never> {
    return (onEvent) =>
      Effect.gen(function* () {
        const fake = new FakeAdapter(agent, `session-${made.length + 1}`, onEvent);
        yield* onEvent({ type: 'session_started', agent, sessionId: fake.sessionId });
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

  /** Records the answer and resolves the request, as a real adapter does; an unknown one fails. */
  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest> {
    return Effect.suspend(() => {
      if (!this.requests.has(requestId)) {
        return new UnknownPermissionRequest({ requestId, optionId });
      }
      this.requests.delete(requestId);
      this.answers.push([requestId, optionId]);
      return this.onEvent({ type: 'permission_resolved', turnId: this.turnId, requestId, outcome: { outcome: 'selected', optionId } });
    });
  }

  /** Announces a permission request the test can then answer. */
  askPermission(requestId: string): Promise<void> {
    this.requests.add(requestId);
    return Effect.runPromise(
      this.onEvent({
        type: 'permission_request',
        turnId: this.turnId,
        requestId,
        toolCall: { toolCallId: 'tool-1', title: 'rm -rf /', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      })
    );
  }

  private get turnId(): string {
    return `turn-${this.prompts.length}`;
  }

  endTurn(): Promise<void> {
    return Effect.runPromise(this.onEvent({ type: 'turn_ended', turnId: this.turnId, stopReason: 'end_turn' }));
  }
}
