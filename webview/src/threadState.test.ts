import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events';
import type { ThreadEvent, ThreadInfo } from '../../src/protocol';
import { agentStatus, applyEvent, awaitingApproval, emptyThread, threadReducer, type ThreadState, type TurnItem } from './threadState';

const at = (event: AgentEvent, time = 0): ThreadEvent => ({ event, at: time });

const chunk = (messageId: string, text: string, kind: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk'): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: kind, messageId, content: { type: 'text', text } },
});

const turnStarted: AgentEvent = { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Count to 3' }] };
const thread: ThreadInfo = { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' };
const fold = (events: ThreadEvent[]): ThreadState => threadReducer(emptyThread, { type: 'history', thread, mode: 'auto_edit', model: null, events });

describe('threadState', () => {
  it('groups a turn’s prompt, thinking, reply and timing', () => {
    const state = fold([
      at({ type: 'session_started', agent: 'claude', sessionId: 's1' }),
      at(turnStarted, 1_000),
      at({ type: 'session_configured', model: 'claude-opus-5', permissionMode: 'default' }, 1_100),
      at(chunk('m:0', 'Let me count', 'agent_thought_chunk'), 1_200),
      at(chunk('m:1', '1'), 1_300),
      at(chunk('m:1', '\n2'), 1_400),
      at(chunk('m:2', 'done'), 1_500),
      at({ type: 'turn_ended', turnId: 't1', stopReason: 'end_turn' }, 43_000),
    ]);

    expect(state).toMatchObject({
      thread,
      config: { model: 'claude-opus-5', permissionMode: 'default' },
      running: false,
      items: [
        {
          kind: 'turn',
          id: 't1',
          prompt: 'Count to 3',
          startedAt: 1_000,
          endedAt: 43_000,
          stopReason: 'end_turn',
          thoughts: [{ id: 'm:0', text: 'Let me count' }],
          messages: [
            { id: 'm:1', text: '1\n2' },
            { id: 'm:2', text: 'done' },
          ],
          errors: [],
        },
      ],
    });
  });

  it('replaces only the streaming turn and text, keeping the others identical', () => {
    const before = [
      at({ type: 'turn_started', turnId: 't0', prompt: [{ type: 'text', text: 'Earlier' }] }),
      at({ type: 'turn_ended', turnId: 't0', stopReason: 'end_turn' }),
      at(turnStarted),
      at(chunk('m:0', 'first')),
      at(chunk('m:1', 'str')),
    ].reduce(applyEvent, emptyThread);
    const after = applyEvent(before, at(chunk('m:1', 'eaming')));

    expect(after.items[0]).toBe(before.items[0]);
    const [turnBefore, turnAfter] = [before.items[1], after.items[1]];
    expect(turnAfter).not.toBe(turnBefore);
    if (turnBefore.kind !== 'turn' || turnAfter.kind !== 'turn') {
      throw new Error('expected turns');
    }
    expect(turnAfter.messages[0]).toBe(turnBefore.messages[0]);
    expect(turnAfter.messages[1]).toEqual({ id: 'm:1', text: 'streaming', index: 1 });
  });

  it('groups a tool call and what the agent said about it, in the order everything arrived', () => {
    const state = fold([
      at(turnStarted),
      at(chunk('m:0', 'Looking')),
      at({
        type: 'session_update',
        turnId: 't1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } },
      }),
      at({
        type: 'session_update',
        turnId: 't1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'notes.md' } }],
        },
      }),
      at(chunk('m:1', 'Found it')),
    ]);

    const turn = onlyTurn(state);
    expect(turn.tools).toEqual([
      {
        id: 'call_1',
        title: 'ls',
        toolKind: 'execute',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'notes.md' } }],
        rawInput: { command: 'ls' },
        rawOutput: undefined,
        approval: undefined,
        index: 1,
      },
    ]);
    expect(turn.messages.map((message) => message.index)).toEqual([0, 2]);
  });

  it('shows the ask on the tool call it is about, and what the user answered', () => {
    const asked = fold([
      at(turnStarted),
      at({
        type: 'permission_request',
        turnId: 't1',
        requestId: 'permission-1',
        toolCall: { toolCallId: 'call_1', title: 'rm notes.md', kind: 'delete', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      }),
    ]);

    expect(awaitingApproval(asked)).toBe(true);
    expect(agentStatus(asked)).toBe('needs_approval');
    expect(onlyTurn(asked).tools[0]).toMatchObject({ id: 'call_1', title: 'rm notes.md', status: 'pending', approval: { requestId: 'permission-1' } });

    const allowed = applyEvent(asked, at({ type: 'permission_resolved', turnId: 't1', requestId: 'permission-1', outcome: { outcome: 'selected', optionId: 'allow' } }));
    expect(awaitingApproval(allowed)).toBe(false);
    // Until the agent says what the tool did, the answer itself says the call went ahead.
    expect(onlyTurn(allowed).tools[0]).toMatchObject({ status: 'in_progress', approval: { outcome: { outcome: 'selected', optionId: 'allow' } } });

    const denied = applyEvent(asked, at({ type: 'permission_resolved', turnId: 't1', requestId: 'permission-1', outcome: { outcome: 'selected', optionId: 'deny' } }));
    expect(onlyTurn(denied).tools[0].status).toBe('failed');

    const cancelled = applyEvent(asked, at({ type: 'permission_resolved', turnId: 't1', requestId: 'permission-1', outcome: { outcome: 'cancelled' } }));
    expect(cancelled.items.length).toBe(1);
    expect(onlyTurn(cancelled).tools[0].status).toBe('failed');
  });

  it('keeps turn errors in their turn and others in the transcript', () => {
    const state = fold([
      at({ type: 'error', code: 'binary_missing', message: 'Claude Code ("claude") was not found on PATH.' }),
      at(turnStarted),
      at({ type: 'error', turnId: 't1', code: 'not_signed_in', message: 'Claude Code is not signed in.' }),
      at({ type: 'turn_ended', turnId: 't1', stopReason: 'error' }),
    ]);

    expect(state.running).toBe(false);
    expect(state.items[0]).toEqual({ kind: 'error', id: 'error:0', code: 'binary_missing', message: expect.any(String) });
    expect(state.items[1]).toMatchObject({
      kind: 'turn',
      stopReason: 'error',
      errors: [{ kind: 'error', id: 't1:error:0', code: 'not_signed_in', message: 'Claude Code is not signed in.' }],
    });
  });

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

    const switched = threadReducer(withBranch, { type: 'history', thread: { id: 'thread-2', agent: 'claude', workspace: null }, mode: 'plan', model: null, events: [] });
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
function onlyTurn(state: ThreadState): TurnItem {
  const turn = state.items.find((item) => item.kind === 'turn');
  if (turn?.kind !== 'turn') {
    throw new Error('expected a turn');
  }
  return turn;
}
