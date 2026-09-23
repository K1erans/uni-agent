import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events';
import type { ThreadEvent, ThreadInfo } from '../../src/protocol';
import { agentStatus, applyEvent, emptyThread, threadReducer, type ThreadState } from './threadState';

const at = (event: AgentEvent, time = 0): ThreadEvent => ({ event, at: time });

const chunk = (messageId: string, text: string, kind: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk'): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: kind, messageId, content: { type: 'text', text } },
});

const turnStarted: AgentEvent = { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Count to 3' }] };
const thread: ThreadInfo = { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' };
const fold = (events: ThreadEvent[]): ThreadState => threadReducer(emptyThread, { type: 'history', thread, mode: 'auto_edit', model: null, readOnly: null, events });

describe('threadState', () => {

  it('reports the agent’s status from the latest turn', () => {
    const missing = fold([at({ type: 'error', code: 'binary_missing', message: 'missing' })]);
    expect(agentStatus(missing)).toBe('not_found');

    const working = applyEvent(missing, at(turnStarted));
    expect(agentStatus(working)).toBe('working');

    const crashed = [
      at({ type: 'error', turnId: 't1', code: 'process_crashed', message: 'crashed' }),
      at({ type: 'turn_ended', turnId: 't1', stopReason: 'error' }),
    ].reduce(applyEvent, working);
    expect(agentStatus(crashed)).toBe('stopped');

    const apiError = [
      at({ type: 'turn_started', turnId: 't2', prompt: [{ type: 'text', text: 'again' }] }),
      at({ type: 'error', turnId: 't2', code: 'agent_error', message: 'Overloaded' }),
      at({ type: 'turn_ended', turnId: 't2', stopReason: 'error' }),
    ].reduce(applyEvent, crashed);
    expect(agentStatus(apiError)).toBe('ready');
  });

  it('ignores events for a thread other than the one shown, and resets on history', () => {
    const shown = fold([at(turnStarted)]);
    const stray = threadReducer(shown, { type: 'event', threadId: 'thread-2', ...at(chunk('m:0', 'elsewhere')) });
    expect(stray).toBe(shown);

    const withBranch = threadReducer(shown, { type: 'branch', name: 'main' });
    expect(withBranch.branch).toBe('main');

    const switched = threadReducer(withBranch, { type: 'history', thread: { id: 'thread-2', agent: 'claude', workspace: null }, mode: 'plan', model: null, readOnly: null, events: [] });
    expect(switched).toEqual({ ...emptyThread, thread: { id: 'thread-2', agent: 'claude', workspace: null }, mode: 'plan' });
  });

  it('follows the mode the extension reports for the shown thread', () => {
    const shown = fold([]);
    expect(shown.mode).toBe('auto_edit');

    expect(threadReducer(shown, { type: 'mode', threadId: 'thread-1', mode: 'plan' }).mode).toBe('plan');
    expect(threadReducer(shown, { type: 'mode', threadId: 'thread-2', mode: 'plan' })).toBe(shown);
  });
});

/** The one turn the state holds, for tests that build a single turn. */
