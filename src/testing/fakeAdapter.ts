import { Deferred, Effect } from 'effect';
import type { AgentAdapter, EventSink, MakeAdapter } from '../agents/adapter';
import { ModeChangeFailed, UnknownPermissionRequest } from '../agents/adapter';
import type { AgentKind, ContentBlock, Mode, StopReason } from '../agents/events';

/** An adapter for tests whose turns run until the test ends them. */
export class FakeAdapter implements AgentAdapter {
  readonly prompts: ReadonlyArray<ContentBlock>[] = [];
  /** The answers the thread routed to this adapter, as request and option IDs. */
  readonly answers: [string, string][] = [];
  /** The mode the adapter was built with, then each one the thread switched it to. */
  readonly modes: Mode[];
  readonly models: (string | undefined)[] = [];
  /** Set by a test to make the agent refuse every mode switch. */
  refusesModes = false;
  disposed = false;
  private readonly requests = new Set<string>();
  private pending: Deferred.Deferred<StopReason> | undefined;

  constructor(
    readonly agent: AgentKind,
    readonly sessionId: string,
    private readonly onEvent: EventSink,
    mode: Mode
  ) {
    this.modes = [mode];
  }

  /** Builds fake adapters for `agent`, recording each one in `made`, announcing sessions like Claude's adapter does. */
  static maker(made: FakeAdapter[], agent: AgentKind = 'claude'): MakeAdapter<never> {
    return (onEvent, mode) =>
      Effect.gen(function* () {
        const fake = new FakeAdapter(agent, `session-${made.length + 1}`, onEvent, mode);
        yield* onEvent({ type: 'session_started', agent, sessionId: fake.sessionId });
        yield* Effect.addFinalizer(() => Effect.sync(() => (fake.disposed = true)));
        made.push(fake);
        return fake;
      });
  }

  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason> {
    return Effect.gen(this, function* () {
      this.pending = yield* Deferred.make<StopReason>();
        this.prompts.push(prompt);
      yield* this.onEvent({ type: 'turn_started', turnId: `turn-${this.prompts.length}`, prompt });
      return yield* Deferred.await(this.pending);
    });
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

  setMode(mode: Mode): Effect.Effect<void, ModeChangeFailed> {
    return Effect.suspend(() =>
      this.refusesModes ? new ModeChangeFailed({ agent: this.agent, mode, reason: 'refused by the test' }) : Effect.sync(() => void this.modes.push(mode))
    );
  }

  setModel(model: string | undefined): Effect.Effect<void> {
    return Effect.sync(() => { this.models.push(model); });
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

  say(text: string): Promise<void> {
    return Effect.runPromise(this.onEvent({
      type: 'session_update', turnId: this.turnId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: `${this.turnId}:message`, content: { type: 'text', text } },
    }));
  }

  endTurn(): Promise<void> {
    return Effect.runPromise(Effect.gen(this, function* () {
      yield* this.onEvent({ type: 'turn_ended', turnId: this.turnId, stopReason: 'end_turn' });
      if (this.pending) {
        yield* Deferred.succeed(this.pending, 'end_turn');
      }
      yield* Effect.yieldNow();
    }));
  }
}
