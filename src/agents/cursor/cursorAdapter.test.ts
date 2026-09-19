import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { agentRequest, exit, methodNotFound, notification, notify, request, result, setupAdapter } from '../../testing/stdioFixtures';
import { CLIENT_INFO } from '../jsonRpcAdapter';
import type { TrafficLine, WireMessage } from '../traffic';
import { CursorAdapter } from './cursorAdapter';

const SESSION = 'session-a';
const SESSION_CONFIG = {
  models: { currentModelId: 'gpt-6[effort=high]', availableModels: [{ modelId: 'gpt-6[effort=high]', name: 'GPT-6' }] },
  modes: { currentModeId: 'agent' },
};

const initialize: TrafficLine[] = [
  request(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: CLIENT_INFO,
  }),
  result(1, { protocolVersion: 1, agentCapabilities: { loadSession: true } }),
];

/** Starts `agent acp` and a new session, taking request IDs 1 and 2. */
const handshake: TrafficLine[] = [
  ...initialize,
  request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
  result(2, { sessionId: SESSION, ...SESSION_CONFIG }),
];

const prompt = (id: number, text: string) => request(id, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text }] });
const update = (value: WireMessage) => notification('session/update', { sessionId: SESSION, update: value });
const chunk = (sessionUpdate: string, text: string) => update({ sessionUpdate, content: { type: 'text', text } });

describe('CursorAdapter', () => {
  it('starts `agent acp` with the first prompt and announces the session Cursor creates', async () => {
    const setup = setupAdapter(CursorAdapter.make, [[...handshake, prompt(3, 'hi'), result(3, { stopReason: 'end_turn' })]]);

    expect(await setup.prompt('hi')).toBe('end_turn');
    expect(setup.spawned).toEqual([{ executable: '/usr/local/bin/agent', args: ['acp'], cwd: '/workspace' }]);
    expect(setup.events.map((event) => event.type)).toEqual(['turn_started', 'session_started', 'session_configured', 'turn_ended']);
    expect(setup.events[1]).toEqual({ type: 'session_started', agent: 'cursor', sessionId: SESSION });
    expect(setup.events[2]).toEqual({ type: 'session_configured', model: 'GPT-6', permissionMode: 'agent' });
  });

  it('streams chunks, grouping consecutive chunks of one kind into a message', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'count'),
        chunk('agent_thought_chunk', 'Counting'),
        chunk('agent_thought_chunk', ' to two.'),
        chunk('agent_message_chunk', '1'),
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '', mimeType: 'image/png' } }),
        update({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
        chunk('agent_message_chunk', '\n2'),
        chunk('agent_thought_chunk', 'Done.'),
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('count')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
    expect(setup.chunks()).toEqual([
      ['agent_thought_chunk', 'turn-1:1', 'Counting'],
      ['agent_thought_chunk', 'turn-1:1', ' to two.'],
      ['agent_message_chunk', 'turn-1:2', '1'],
      ['agent_message_chunk', 'turn-1:2', '\n2'],
      ['agent_thought_chunk', 'turn-1:3', 'Done.'],
    ]);
  });

  it('declines requests outside standard ACP, such as Cursor extensions, with "method not found"', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'hi'),
        agentRequest(7, 'cursor/ask_question', { question: 'Which?' }),
        methodNotFound(7, 'cursor/ask_question'),
        agentRequest(8, 'session/request_permission', { sessionId: SESSION }),
        methodNotFound(8, 'session/request_permission'),
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('hi')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
  });

  it('sends session/cancel when cancelled, and ends the turn as cancelled', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'hi'),
        chunk('agent_message_chunk', 'Working'),
        notify('session/cancel', { sessionId: SESSION }),
        result(3, { stopReason: 'cancelled' }),
      ],
    ]);

    const turn = setup.prompt('hi');
    await vi.waitFor(() => expect(setup.chunks()).toHaveLength(1));
    await Effect.runPromise(setup.adapter.cancel());
    expect(await turn).toBe('cancelled');
    expect(setup.errors()).toEqual([]);
  });

  it('ends the connection with a crash when Cursor answers with a malformed result', async () => {
    const setup = setupAdapter(CursorAdapter.make, [[...handshake, prompt(3, 'hi'), result(3, { stopReason: 'finished' })]]);

    expect(await setup.prompt('hi')).toBe('error');
    expect(setup.errors()).toEqual([
      expect.objectContaining({ turnId: 'turn-1', code: 'process_crashed', message: expect.stringContaining('malformed session/prompt result') }),
    ]);
  });

  it('reports a crash, then loads the session in a new process without replaying its history', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [...handshake, prompt(3, 'first'), exit('the process exited with code 1')],
      [
        ...initialize,
        request(2, 'session/load', { sessionId: SESSION, cwd: '/workspace', mcpServers: [] }),
        chunk('agent_message_chunk', 'history'),
        result(2, SESSION_CONFIG),
        prompt(3, 'second'),
        chunk('agent_message_chunk', 'back'),
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('first')).toBe('error');
    expect(setup.errors()).toEqual([
      { type: 'error', turnId: 'turn-1', code: 'process_crashed', message: 'Cursor stopped unexpectedly: the process exited with code 1' },
    ]);

    expect(await setup.prompt('second')).toBe('end_turn');
    expect(setup.chunks()).toEqual([['agent_message_chunk', 'turn-2:1', 'back']]);
    expect(setup.events.filter((event) => event.type === 'session_started')).toHaveLength(1);
  });

  it('ends a running turn as cancelled when disposed', async () => {
    const setup = setupAdapter(CursorAdapter.make, [[...handshake, prompt(3, 'hi')]]);

    const turn = setup.prompt('hi');
    await Effect.runPromise(Effect.yieldNow());
    await setup.dispose();
    expect(await turn).toBe('cancelled');
    expect(setup.errors()).toEqual([]);
  });
});
