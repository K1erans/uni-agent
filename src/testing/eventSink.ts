import { Effect } from 'effect';
import type { AgentAdapter, EventSink } from '../agents/adapter';
import type { AgentEvent, PermissionOption } from '../agents/events';

/** How the user answers a permission request; no answer leaves the request open. */
export type Answer = (options: ReadonlyArray<PermissionOption>) => string | undefined;

/** Allows the call once, as a user watching the thread would; fixtures are recorded and replayed with it. */
export const allowOnce: Answer = (options) => options.find((option) => option.kind === 'allow_once')?.optionId;

/**
 * A sink that keeps every event an adapter emits and answers its permission requests the way
 * `answer` says. The adapter is reached through `adapter`, since it does not exist until the sink
 * has been handed to it. Answers are given on a fiber of their own, as the user's would be.
 */
export function recordingSink(events: AgentEvent[], answer: Answer | undefined, adapter: () => AgentAdapter | undefined): EventSink {
  return (event) =>
    Effect.suspend(() => {
      events.push(event);
      const open = adapter();
      const optionId = event.type === 'permission_request' && answer ? answer(event.options) : undefined;
      if (event.type !== 'permission_request' || optionId === undefined || !open) {
        return Effect.void;
      }
      return Effect.asVoid(Effect.forkDaemon(Effect.ignore(open.respond(event.requestId, optionId))));
    });
}
