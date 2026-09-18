import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events';
import { applyEvent, emptyThread, threadReducer } from './threadState';

const chunk = (messageId: string, text: string): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
});

const turnStarted: AgentEvent = { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Count to 3' }] };

describe('threadState', () => {
  it('builds a transcript from a turn', () => {
    const events: AgentEvent[] = [
      { type: 'session_started', agent: 'claude', sessionId: 's1' },
      turnStarted,
      chunk('m:0', '1'),
      chunk('m:0', '\n2'),
      chunk('m:1', 'done'),
      { type: 'turn_ended', turnId: 't1', stopReason: 'end_turn' },
    ];

    expect(threadReducer(emptyThread, { type: 'history', events })).toEqual({
      running: false,
      items: [
        { kind: 'user', id: 't1:prompt', text: 'Count to 3' },
        { kind: 'agent_message', id: 'm:0', text: '1\n2' },
        { kind: 'agent_message', id: 'm:1', text: 'done' },
      ],
    });
  });

  it('replaces only the streaming item, keeping the others identical', () => {
    const before = [turnStarted, chunk('m:0', 'first'), chunk('m:1', 'str')].reduce(applyEvent, emptyThread);
    const after = applyEvent(before, chunk('m:1', 'eaming'));

    expect(after.items[0]).toBe(before.items[0]);
    expect(after.items[1]).toBe(before.items[1]);
    expect(after.items[2]).not.toBe(before.items[2]);
    expect(after.items[2]).toMatchObject({ text: 'streaming' });
  });

  it('shows errors as their own items and marks the turn finished', () => {
    const events: AgentEvent[] = [
      turnStarted,
      { type: 'error', turnId: 't1', code: 'not_signed_in', message: 'Claude Code is not signed in.' },
      { type: 'turn_ended', turnId: 't1', stopReason: 'error' },
    ];
    const state = events.reduce(applyEvent, emptyThread);

    expect(state.running).toBe(false);
    expect(state.items[1]).toEqual({ kind: 'error', id: 'error:1', code: 'not_signed_in', message: 'Claude Code is not signed in.' });
  });

  it('is running between turn_started and turn_ended', () => {
    expect(applyEvent(emptyThread, turnStarted).running).toBe(true);
  });
});
