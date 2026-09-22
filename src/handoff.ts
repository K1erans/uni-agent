import { Data, Effect } from 'effect';
import type { PromptRejected, TurnResult } from './thread';

export interface HandoffAgent {
  run(prompt: string): Effect.Effect<TurnResult, PromptRejected>;
}

export class HandoffFailed extends Data.TaggedError('HandoffFailed')<{ readonly reason: string }> {}

export interface HandoffResult {
  readonly brief: string;
  readonly planning: TurnResult;
  readonly implementation: TurnResult;
}

/** The planning agent has the context; ask it for a brief another agent can act on. */
export function handoffBriefPrompt(originalRequest: string, contextPaths: ReadonlyArray<string>): string {
  const references = contextPaths.length ? contextPaths.map((path) => `- ${path}`).join('\n') : '- None supplied';
  return [
    'Write a self-contained implementation brief for another coding agent. Do not implement it.',
    'Include the goal, accepted plan, acceptance criteria, key files, user constraints, rejected approaches and why, and any gotchas.',
    'Say when a required detail is unknown. Return only the brief.',
    '',
    'Original request:',
    originalRequest,
    '',
    'Context references (paths only):',
    references,
  ].join('\n');
}

/**
 * Runs the handoff as one Effect. The target is created only after the planning agent produces a
 * complete brief; an error or cancelled planning turn cannot create or prompt the target.
 */
export function runHandoff<E, R>(
  planning: HandoffAgent,
  createTarget: (brief: string) => Effect.Effect<HandoffAgent, E, R>,
  originalRequest: string,
  contextPaths: ReadonlyArray<string>,
  briefPrompt = handoffBriefPrompt(originalRequest, contextPaths)
): Effect.Effect<HandoffResult, HandoffFailed | E, R> {
  return Effect.gen(function* () {
    const result = yield* planning.run(briefPrompt).pipe(
      Effect.mapError(() => new HandoffFailed({ reason: 'The planning agent was already running a turn.' }))
    );
    const brief = result.response.trim();
    if (result.stopReason !== 'end_turn' || !brief) {
      return yield* new HandoffFailed({ reason: `The planning turn ended as ${result.stopReason} without a usable brief.` });
    }
    const target = yield* createTarget(brief);
    const implementation = yield* target.run(
      `Implement this brief. Preserve its acceptance criteria and constraints.\n\n${brief}\n\nOriginal request:\n${originalRequest}\n\nContext references (paths only):\n${contextPaths.map((path) => `- ${path}`).join('\n') || '- None supplied'}`
    ).pipe(Effect.mapError(() => new HandoffFailed({ reason: 'The target agent was already running a turn.' })));
    if (implementation.stopReason !== 'end_turn') {
      return yield* new HandoffFailed({ reason: `The target turn ended as ${implementation.stopReason}.` });
    }
    return { brief, planning: result, implementation };
  });
}
