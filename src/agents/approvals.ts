import { Deferred, Effect } from 'effect';
import { UnknownPermissionRequest, type EventSink } from './adapter';
import type { PermissionOption, PermissionOutcome, ToolCall } from './events';

/** A permission request waiting for the user: the turn it belongs to, the options it offers and whoever waits for the answer. */
interface OpenRequest {
  readonly turnId: string;
  readonly optionIds: ReadonlySet<string>;
  readonly answer: Deferred.Deferred<PermissionOutcome>;
}

/**
 * An adapter's open permission requests, each waiting on a `Deferred` keyed by its request ID. The
 * user's answer completes it through `respond`; stopping the turn or the adapter cancels every
 * one still open. Each request is announced with `permission_request` and resolved exactly once
 * with `permission_resolved`, so a thread can tell from its events whether it is waiting.
 */
export class Approvals {
  private requests = 0;
  private readonly open = new Map<string, OpenRequest>();

  constructor(private readonly emit: EventSink) {}

  /**
   * Asks the user for permission and waits for the answer. The request is registered before it is
   * announced, so an answer that arrives straight away is not lost.
   */
  ask(turnId: string, toolCall: ToolCall, options: ReadonlyArray<PermissionOption>): Effect.Effect<PermissionOutcome> {
    return Effect.gen(this, function* () {
      const requestId = `permission-${++this.requests}`;
      const answer = yield* Deferred.make<PermissionOutcome>();
      this.open.set(requestId, { turnId, optionIds: new Set(options.map((option) => option.optionId)), answer });
      yield* this.emit({ type: 'permission_request', turnId, requestId, toolCall, options });
      return yield* Deferred.await(answer);
    });
  }

  /** Answers an open request with one of its options. */
  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest> {
    return Effect.suspend(() => {
      const request = this.open.get(requestId);
      if (!request || !request.optionIds.has(optionId)) {
        return new UnknownPermissionRequest({ requestId, optionId });
      }
      return this.resolve(requestId, request, { outcome: 'selected', optionId });
    });
  }

  /** Cancels one open request, such as one the agent withdrew; does nothing once it is answered. */
  cancel(requestId: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const request = this.open.get(requestId);
      return request ? this.resolve(requestId, request, { outcome: 'cancelled' }) : Effect.void;
    });
  }

  /** Cancels every open request. */
  cancelAll(): Effect.Effect<void> {
    return Effect.suspend(() => Effect.forEach([...this.open.keys()], (requestId) => this.cancel(requestId), { discard: true }));
  }

  private resolve(requestId: string, request: OpenRequest, outcome: PermissionOutcome): Effect.Effect<void> {
    this.open.delete(requestId);
    return Effect.zipRight(
      this.emit({ type: 'permission_resolved', turnId: request.turnId, requestId, outcome }),
      Deferred.succeed(request.answer, outcome)
    );
  }
}
