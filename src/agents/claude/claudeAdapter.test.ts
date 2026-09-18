import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events';
import type { TrafficLine } from '../traffic';
import { ClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQueryFn } from './claudeAdapter';
import { replayQuery } from './claudeTraffic';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

function userMessage(text: string) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  };
}

function textStream(messageId: string, ...deltas: string[]): TrafficLine[] {
  return [
    { dir: 'recv', data: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId } } } },
    ...deltas.map((text): TrafficLine => ({
      dir: 'recv',
      data: {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      },
    })),
    { dir: 'recv', data: assistant(messageId, deltas.join('')) },
  ];
}

function assistant(id: string, text: string, error?: string) {
  return { type: 'assistant', parent_tool_use_id: null, error, message: { id, content: [{ type: 'text', text }] } };
}

function result(fields: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', ...fields };
}

/** Builds an adapter over a fake agent, capturing the events it emits and the options it starts Claude with. */
function setup(traffic: TrafficLine[][], overrides: Partial<ClaudeAdapterOptions> = {}) {
  const events: AgentEvent[] = [];
  const started: Options[] = [];
  const sessions = [...traffic];
  const query: ClaudeQueryFn = (params) => {
    started.push(params.options);
    return replayQuery(sessions.shift() ?? [])(params);
  };
  let turn = 0;
  const adapter = new ClaudeAdapter({
    cwd: '/workspace',
    query,
    findClaude: () => '/usr/local/bin/claude',
    newId: () => (turn++ === 0 ? SESSION_ID : `turn-${turn - 1}`),
    ...overrides,
  });
  adapter.onEvent((event) => events.push(event));
  const prompt = (text: string) => adapter.prompt([{ type: 'text', text }]);
  return { adapter, events, started, prompt };
}

const chunks = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === 'session_update' && event.update.sessionUpdate === 'agent_message_chunk'
      ? [[event.update.messageId, event.update.content.text]]
      : []
  );

describe('ClaudeAdapter', () => {
  it('generates the session ID up front and hands it to Claude', async () => {
    const { adapter, events, started, prompt } = setup([[{ dir: 'send', data: userMessage('hi') }, { dir: 'recv', data: result() }]]);

    expect(adapter.sessionId).toBe(SESSION_ID);
    adapter.start();
    expect(events).toEqual([{ type: 'session_started', agent: 'claude', sessionId: SESSION_ID }]);

    await prompt('hi');
    expect(started[0]).toMatchObject({ sessionId: SESSION_ID, pathToClaudeCodeExecutable: '/usr/local/bin/claude', cwd: '/workspace' });
    expect(started[0].resume).toBeUndefined();
  });

  it('streams text deltas as chunks of one message and skips its complete copy', async () => {
    const { events, prompt } = setup([
      [{ dir: 'send', data: userMessage('count') }, ...textStream('msg_1', '1', '\n2'), { dir: 'recv', data: result() }],
    ]);

    expect(await prompt('count')).toBe('end_turn');
    expect(chunks(events)).toEqual([
      ['msg_1:0', '1'],
      ['msg_1:0', '\n2'],
    ]);
  });

  it('shows assistant messages that never streamed whole', async () => {
    const { events, prompt } = setup([
      [{ dir: 'send', data: userMessage('hi') }, { dir: 'recv', data: assistant('msg_synthetic', 'No response requested.') }, { dir: 'recv', data: result() }],
    ]);

    await prompt('hi');
    expect(chunks(events)).toEqual([['msg_synthetic:0', 'No response requested.']]);
  });

  it('ignores subagent traffic', async () => {
    const subagent = { type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_start', message: { id: 'msg_sub' } } };
    const { events, prompt } = setup([
      [{ dir: 'send', data: userMessage('hi') }, { dir: 'recv', data: subagent }, { dir: 'recv', data: { ...assistant('msg_sub', 'inner'), parent_tool_use_id: 'toolu_1' } }, { dir: 'recv', data: result() }],
    ]);

    await prompt('hi');
    expect(chunks(events)).toEqual([]);
  });

  it('reports a missing binary in the thread instead of starting Claude', async () => {
    const { adapter, events, started, prompt } = setup([], { findClaude: () => undefined });

    adapter.start();
    expect(await prompt('hi')).toBe('error');
    expect(started).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ code: 'binary_missing', message: expect.stringContaining('not found on PATH') }),
      expect.objectContaining({ code: 'binary_missing', turnId: 'turn-1' }),
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'error' });
  });

  it('names the configured path when the executablePath setting is wrong', () => {
    let override: string | undefined;
    const { adapter, events } = setup([], {
      executablePath: '/opt/claude',
      findClaude: (path) => ((override = path), undefined),
    });

    adapter.start();
    expect(override).toBe('/opt/claude');
    expect(events[1]).toMatchObject({ code: 'binary_missing', message: expect.stringContaining('"/opt/claude"') });
  });

  it('reports the first error of a turn only once', async () => {
    const { events, prompt } = setup([
      [
        { dir: 'send', data: userMessage('hi') },
        { dir: 'recv', data: assistant('msg_1', 'API Error: 529 Overloaded', 'overloaded') },
        { dir: 'recv', data: result({ is_error: true, result: 'API Error: 529 Overloaded' }) },
      ],
    ]);

    expect(await prompt('hi')).toBe('error');
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', turnId: 'turn-1', code: 'agent_error', message: 'API Error: 529 Overloaded' },
    ]);
  });

  it('reports an error result that no assistant message explained', async () => {
    const { events, prompt } = setup([
      [{ dir: 'send', data: userMessage('hi') }, { dir: 'recv', data: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] } }],
    ]);

    expect(await prompt('hi')).toBe('error');
    expect(events).toContainEqual({ type: 'error', turnId: 'turn-1', code: 'agent_error', message: 'boom' });
  });

  it('reports a crash with the tail of stderr, then resumes the session on the next prompt', async () => {
    const crashing: TrafficLine[] = [
      { dir: 'send', data: userMessage('first') },
      // Claude has written the session once it streams anything, so a restart must resume it.
      ...textStream('msg_1', 'partial').slice(0, 1),
      { dir: 'exit', error: 'Claude Code process exited with code 1' },
    ];
    const recovered: TrafficLine[] = [{ dir: 'send', data: userMessage('second') }, ...textStream('msg_2', 'back'), { dir: 'recv', data: result() }];
    const { events, started, prompt } = setup([crashing, recovered]);

    const firstTurn = prompt('first');
    started[0].stderr?.('Error: segfault\n');
    expect(await firstTurn).toBe('error');
    expect(events).toContainEqual({
      type: 'error',
      turnId: 'turn-1',
      code: 'process_crashed',
      message: 'Claude Code stopped unexpectedly: Claude Code process exited with code 1\n\nError: segfault',
    });

    expect(await prompt('second')).toBe('end_turn');
    expect(started[1]).toMatchObject({ resume: SESSION_ID });
    expect(started[1].sessionId).toBeUndefined();
  });

  it('ends a running turn as cancelled when disposed', async () => {
    const { adapter, events, prompt } = setup([[{ dir: 'send', data: userMessage('hi') }]]);

    const turn = prompt('hi');
    adapter.dispose();
    expect(await turn).toBe('cancelled');
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });
});
