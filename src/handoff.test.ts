import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { handoffBriefPrompt, runHandoff, type HandoffAgent } from './handoff';
import type { TurnResult } from './thread';

function delegation(result: TurnResult, prompts: string[]): HandoffAgent {
  return {
    run: (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      return result;
    }),
  };
}

const planningResult: TurnResult = {
  agent: 'codex', model: 'Sol', sessionId: 'plan-session', stopReason: 'end_turn',
  response: 'Goal: implement search.\nAcceptance: tests pass.', events: [],
};

describe('cross-agent handoff', () => {
  it('asks the planning agent for a self-contained brief before creating the implementation session', async () => {
    const planningPrompts: string[] = [];
    const targetPrompts: string[] = [];
    let created = 0;
    const result = await Effect.runPromise(runHandoff(
      delegation(planningResult, planningPrompts),
      (brief) => Effect.sync(() => {
        created++;
        expect(brief).toBe(planningResult.response);
        return delegation({ ...planningResult, agent: 'cursor', model: 'Grok 4.7', response: 'Implemented.' }, targetPrompts);
      }),
      'Add search', ['src/search.ts']
    ));

    expect(created).toBe(1);
    expect(planningPrompts).toEqual([handoffBriefPrompt('Add search', ['src/search.ts'])]);
    expect(targetPrompts[0]).toContain('Acceptance: tests pass.');
    expect(targetPrompts[0]).toContain('src/search.ts');
    expect(result.implementation).toMatchObject({ agent: 'cursor', model: 'Grok 4.7', response: 'Implemented.' });
  });

  it('does not create a target when planning fails', async () => {
    let created = false;
    const failed = { ...planningResult, stopReason: 'error' as const, response: '' };
    const result = await Effect.runPromise(Effect.either(runHandoff(
      delegation(failed, []),
      () => Effect.sync(() => {
        created = true;
        return delegation(planningResult, []);
      }),
      'Add search', []
    )));

    expect(created).toBe(false);
    expect(Either.isLeft(result) && result.left._tag).toBe('HandoffFailed');
  });

  it('reports a failed implementation turn as a failed handoff', async () => {
    const result = await Effect.runPromise(Effect.either(runHandoff(
      delegation(planningResult, []),
      () => Effect.succeed(delegation({ ...planningResult, agent: 'cursor', stopReason: 'error', response: '' }, [])),
      'Add search', []
    )));

    expect(Either.isLeft(result) && result.left.reason).toContain('target turn ended as error');
  });
});
