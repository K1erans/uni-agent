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
  /** The stored session the adapter was made to resume, if any. */
  resumed: string | undefined;
  /** Whether the agent no longer has the session it was made to resume, so its first prompt fails. */
  resumeFails = false;
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

  /**
   * Builds fake adapters for `agent`, recording each one in `made`, announcing new sessions like
   * Claude's adapter does. With `resumable` false, every stored session is gone when resumed.
   */
  static maker(made: FakeAdapter[], agent: AgentKind = 'claude', resumable = true): MakeAdapter<never> {
    return (onEvent, mode, _model, resume) =>
      Effect.gen(function* () {
        const fake = new FakeAdapter(agent, resume ?? `session-${made.length + 1}`, onEvent, mode);
        fake.resumed = resume;
        fake.resumeFails = resume !== undefined && !resumable;
        if (resume === undefined) {
          yield* onEvent({ type: 'session_started', agent, sessionId: fake.sessionId });
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => (fake.disposed = true)));
        made.push(fake);
        return fake;
      });
  }

  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason> {
    return Effect.gen(this, function* () {
      this.pending = yield* Deferred.make<StopReason>();
      this.prompts.push(prompt);
      yield* this.onEvent({ type: 'turn_started', turnId: this.turnId, prompt });
      if (this.resumeFails) {
        yield* this.onEvent({ type: 'error', turnId: this.turnId, code: 'resume_failed', message: 'Claude Code couldn’t resume this thread’s session.' });
        yield* this.onEvent({ type: 'turn_ended', turnId: this.turnId, stopReason: 'error' });
        return 'error';
      }
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

  /** Unique within the thread, as real adapters' are: a resumed session's turns follow the stored ones. */
  private get turnId(): string {
    return this.resumed === undefined ? `turn-${this.prompts.length}` : `resumed-turn-${this.prompts.length}`;
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
