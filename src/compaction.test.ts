import * as fs from 'node:fs';
import * as path from 'node:path';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { emptyThread, threadReducer, type ThreadState } from '../webview/src/threadState';
import { AgentEvent } from './agents/events';
import { Compactor, type CompactedEvent } from './compaction';
import type { ThreadEvent } from './protocol';

const thread = { id: 'thread-1', agent: 'claude', workspace: null } as const;

/** What the webview shows for these events. */
function shown(events: ReadonlyArray<ThreadEvent>): ThreadState {
  return threadReducer(emptyThread, { type: 'history', thread, mode: 'auto_edit', model: null, readOnly: null, events });
}

/** Stores `events`, one arriving per millisecond, and returns the rows in the order they replay. */
function compact(events: ReadonlyArray<AgentEvent>): CompactedEvent[] {
  const compactor = new Compactor(0);
  return events.flatMap((event, at) => compactor.push(event, at)).sort((a, b) => a.seq - b.seq || a.part - b.part);
}

const live = (events: ReadonlyArray<AgentEvent>) => events.map((event, at) => ({ event, at }));
const replayed = (rows: ReadonlyArray<CompactedEvent>) => rows.map(({ event, at }) => ({ event, at }));

const FIXTURES = ['claude', 'codex', 'cursor'].flatMap((agent) => {
  const folder = path.join(__dirname, 'agents', agent, 'fixtures');
  return fs.readdirSync(folder).filter((file) => file.endsWith('.events.json')).map((file) => path.join(folder, file));
});

const turnStarted = (turnId = 't1'): AgentEvent => ({ type: 'turn_started', turnId, prompt: [{ type: 'text', text: 'go' }] });
const turnEnded = (turnId = 't1'): AgentEvent => ({ type: 'turn_ended', turnId, stopReason: 'end_turn' });
const chunk = (messageId: string, text: string, kind: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk'): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: kind, messageId, content: { type: 'text', text } },
});

describe('Compactor', () => {
  it.each(FIXTURES.map((file) => [path.relative(path.join(__dirname, 'agents'), file), file]))(
    'replays %s to the same transcript as the live events',
    (_name, file) => {
      const events = Schema.decodeUnknownSync(Schema.Array(AgentEvent))(JSON.parse(fs.readFileSync(file, 'utf8')));
      // Errors outside a turn describe the agent's setup at the time, and are not stored.
      const stored = events.filter((event) => event.type !== 'error' || event.turnId !== undefined);

      const rows = compact(stored);

      expect(shown(replayed(rows))).toEqual(shown(live(stored)));
      expect(rows.length).toBeLessThanOrEqual(stored.length);
    }
  );

  it('merges a message’s chunks into one row, written once something else arrives', () => {
    const compactor = new Compactor(0);
    expect(compactor.push(turnStarted(), 0)).toHaveLength(1);
    expect(compactor.push(chunk('m1', 'Hel'), 1)).toEqual([]);
    expect(compactor.push(chunk('m1', 'lo'), 2)).toEqual([]);

    const written = compactor.push(chunk('m2', 'Hmm', 'agent_thought_chunk'), 3);

    expect(written).toEqual([{ seq: 1, part: 0, turnId: 't1', event: chunk('m1', 'Hello'), at: 1 }]);
    expect(compactor.push(turnEnded(), 4).map(({ event }) => event)).toEqual([chunk('m2', 'Hmm', 'agent_thought_chunk'), turnEnded()]);
  });

  it('writes a tool call once, in its final state, after the permission asked about it and its answer', () => {
    const call = { toolCallId: 'call-1', title: 'rm -rf build', kind: 'execute', status: 'pending' } as const;
    const events: AgentEvent[] = [
      turnStarted(),
      chunk('m1', 'Cleaning up'),
      { type: 'session_update', turnId: 't1', update: { sessionUpdate: 'tool_call', ...call } },
      { type: 'permission_request', turnId: 't1', requestId: 'r1', toolCall: call, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
      { type: 'permission_resolved', turnId: 't1', requestId: 'r1', outcome: { outcome: 'selected', optionId: 'allow' } },
      { type: 'session_update', turnId: 't1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' } },
      {
        type: 'session_update',
        turnId: 't1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] },
      },
      chunk('m2', 'All clean'),
      turnEnded(),
    ];

    const rows = compact(events);

    expect(rows.map(({ seq, part, event }) => [seq, part, event.type])).toEqual([
      [0, 0, 'turn_started'],
      [1, 0, 'session_update'],
      [2, 0, 'permission_request'],
      [2, 1, 'permission_resolved'],
      [2, 2, 'session_update'],
      [3, 0, 'session_update'],
      [4, 0, 'turn_ended'],
    ]);
    expect(rows[4].event).toMatchObject({ update: { sessionUpdate: 'tool_call', status: 'completed', title: 'rm -rf build' } });
    expect(shown(replayed(rows))).toEqual(shown(live(events)));
  });

  it('writes a tool call still running when its turn ends, and news of one already written as its own row', () => {
    const call = { toolCallId: 'call-1', title: 'sleep 60', kind: 'execute', status: 'in_progress' } as const;
    const events: AgentEvent[] = [
      turnStarted(),
      { type: 'session_update', turnId: 't1', update: { sessionUpdate: 'tool_call', ...call } },
      turnEnded(),
      { type: 'session_update', turnId: 't1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' } },
    ];

    const rows = compact(events);

    expect(rows.map(({ event }) => event.type)).toEqual(['turn_started', 'session_update', 'turn_ended', 'session_update']);
    expect(shown(replayed(rows))).toEqual(shown(live(events)));
  });

  it('keeps nothing of session IDs or errors outside a turn', () => {
    const compactor = new Compactor(7);
    expect(compactor.push({ type: 'session_started', agent: 'claude', sessionId: 's1' }, 0)).toEqual([]);
    expect(compactor.push({ type: 'error', code: 'binary_missing', message: 'not found' }, 1)).toEqual([]);
    expect(compactor.push(turnStarted(), 2)).toEqual([{ seq: 7, part: 0, turnId: 't1', event: turnStarted(), at: 2 }]);
  });
});
