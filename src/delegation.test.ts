import { Deferred, Effect, Either, Exit, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import type { MakeAdapter } from './agents/adapter';
import type { AgentEvent } from './agents/events';
import { makeDelegation } from './delegation';

describe('Delegation', () => {
  it('rejects a concurrent prompt without mixing its events into the active turn', async () => {
    const gate = Effect.runSync(Deferred.make<'end_turn'>());
    const scope = Effect.runSync(Scope.make());
    const make: MakeAdapter<never> = (emit) => Effect.succeed({
      agent: 'codex' as const,
      prompt: (prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>) =>
        Effect.zipRight(emit({ type: 'turn_started', turnId: 'turn-1', prompt: [...prompt] }), Deferred.await(gate)),
      cancel: () => Effect.void,
      respond: () => Effect.void,
      setMode: () => Effect.void,
    });
    try {
      const delegation = Effect.runSync(makeDelegation(make).pipe(Scope.extend(scope)));
      const first = Effect.runPromise(delegation.run('first'));
      const second = await Effect.runPromise(Effect.either(delegation.run('second')));
      expect(Either.isLeft(second) && second.left._tag).toBe('TurnInProgress');
      await Effect.runPromise(Deferred.succeed(gate, 'end_turn'));
      const result = await first;
      expect(result.events).toMatchObject([{ type: 'turn_started', prompt: [{ type: 'text', text: 'first' }] }]);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it('returns one reviewable turn while streaming normalized events to its caller', async () => {
    const observed: AgentEvent[] = [];
    let requestedModel: string | undefined;
    const make: MakeAdapter<never> = (emit, _mode, model) =>
      Effect.gen(function* () {
        requestedModel = model;
        yield* emit({ type: 'session_started', agent: 'cursor', sessionId: 'session-1' });
        return {
          agent: 'cursor' as const,
          prompt: (prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>) =>
            Effect.gen(function* () {
              yield* emit({ type: 'turn_started', turnId: 'turn-1', prompt: [...prompt] });
              yield* emit({ type: 'session_configured', model: 'Grok 4.7', permissionMode: 'agent' });
              yield* emit({ type: 'session_update', turnId: 'turn-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'Code ' } } });
              yield* emit({ type: 'session_update', turnId: 'turn-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'written.' } } });
              yield* emit({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' });
              return 'end_turn' as const;
            }),
          cancel: () => Effect.void,
          respond: () => Effect.void,
          setMode: () => Effect.void,
        };
      });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delegation = yield* makeDelegation(make, 'Grok 4.7', 'auto_edit', (event) => Effect.sync(() => void observed.push(event)));
        return yield* delegation.run('Implement the plan');
      }).pipe(Effect.scoped)
    );

    expect(requestedModel).toBe('Grok 4.7');
    expect(result).toMatchObject({ agent: 'cursor', model: 'Grok 4.7', sessionId: 'session-1', stopReason: 'end_turn', response: 'Code written.' });
    expect(result.events.map((event) => event.type)).toEqual(['turn_started', 'session_configured', 'session_update', 'session_update', 'turn_ended']);
    expect(observed.map((event) => event.type)).toEqual(['session_started', ...result.events.map((event) => event.type)]);
  });
});
