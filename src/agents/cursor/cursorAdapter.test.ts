import { Effect, Either } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { modeSettings } from '../../testing/modeSettings';
import { agentRequest, answer, exit, methodNotFound, notification, notify, request, result, rpcError, setupAdapter } from '../../testing/stdioFixtures';
import { ModeChangeFailed } from '../adapter';
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
const TOOL_CALL = { toolCallId: 'call_1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } };
const PERMISSION_OPTIONS = [
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'proceed_always', name: 'Always Allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

describe('CursorAdapter', () => {
  it('starts `agent acp` with the first prompt and announces the session Cursor creates', async () => {
    const setup = setupAdapter(CursorAdapter.make, [[...handshake, prompt(3, 'hi'), result(3, { stopReason: 'end_turn' })]]);

    expect(await setup.prompt('hi')).toBe('end_turn');
    expect(setup.spawned).toEqual([{ executable: '/usr/local/bin/agent', args: ['acp'], cwd: '/workspace' }]);
    expect(setup.events.map((event) => event.type)).toEqual(['turn_started', 'session_started', 'session_configured', 'turn_ended']);
    expect(setup.events[1]).toEqual({ type: 'session_started', agent: 'cursor', sessionId: SESSION });
    expect(setup.events[2]).toEqual({ type: 'session_configured', model: 'GPT-6', permissionMode: 'agent' });
  });

  it('selects a requested model from Cursor session options before sending the prompt', async () => {
    const models = {
      id: 'model', category: 'model', type: 'select', currentValue: 'default[]',
      options: [{ value: 'default[]', name: 'Auto' }, { value: 'grok-4.7[effort=high]', name: 'Grok 4.7' }],
    };
    const setup = setupAdapter(CursorAdapter.make, [[
      ...initialize,
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
      result(2, { sessionId: SESSION, ...SESSION_CONFIG, configOptions: [models] }),
      request(3, 'session/set_config_option', { sessionId: SESSION, configId: 'model', value: 'grok-4.7[effort=high]' }),
      result(3, { configOptions: [{ ...models, currentValue: 'grok-4.7[effort=high]' }] }),
      prompt(4, 'Implement the plan'),
      result(4, { stopReason: 'end_turn' }),
    ]], undefined, undefined, { model: 'Grok 4.7' });

    expect(await setup.prompt('Implement the plan')).toBe('end_turn');
    expect(setup.events).toContainEqual({ type: 'session_configured', model: 'Grok 4.7', permissionMode: 'agent' });
  });

  it('switches the open session model and can return to its default', async () => {
    const models = {
      id: 'model', category: 'model', type: 'select', currentValue: 'default[]',
      options: [{ value: 'default[]', name: 'Auto' }, { value: 'grok-4.7', name: 'Grok 4.7' }],
    };
    const setup = setupAdapter(CursorAdapter.make, [[
      ...initialize, request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
      result(2, { sessionId: SESSION, ...SESSION_CONFIG, configOptions: [models] }),
      prompt(3, 'one'), result(3, { stopReason: 'end_turn' }),
      request(4, 'session/set_config_option', { sessionId: SESSION, configId: 'model', value: 'grok-4.7' }),
      result(4, { configOptions: [{ ...models, currentValue: 'grok-4.7' }] }),
      prompt(5, 'two'), result(5, { stopReason: 'end_turn' }),
      request(6, 'session/set_config_option', { sessionId: SESSION, configId: 'model', value: 'default[]' }),
      result(6, { configOptions: [models] }),
    ]]);
    expect(await setup.prompt('one')).toBe('end_turn');
    await Effect.runPromise(setup.adapter.setModel('grok-4.7'));
    expect(await setup.prompt('two')).toBe('end_turn');
    await Effect.runPromise(setup.adapter.setModel(undefined));
    expect(setup.errors()).toEqual([]);
  });

  it('refuses an unavailable requested model before sending a prompt', async () => {
    const setup = setupAdapter(CursorAdapter.make, [[...handshake]], undefined, undefined, { model: 'Grok 4.7' });

    expect(await setup.prompt('Implement the plan')).toBe('error');
    expect(setup.errors()).toEqual([expect.objectContaining({ code: 'agent_error', message: 'Cursor does not offer model "Grok 4.7" in this session.' })]);
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
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('hi')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
  });

  it('shows a tool call and what the agent says about it as it runs', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'list them'),
        update({ sessionUpdate: 'tool_call', ...TOOL_CALL, status: 'in_progress' }),
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'notes.md' } },
            { type: 'content', content: { type: 'image', data: '', mimeType: 'image/png' } },
            { type: 'diff', path: '/workspace/notes.md', newText: 'Buy milk' },
          ],
        }),
        // An update for a tool call the agent never opened is nothing the thread can show.
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_unknown', status: 'completed' }),
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('list them')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
    expect(setup.toolUpdates()).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        title: undefined,
        kind: undefined,
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'notes.md' } },
          { type: 'diff', path: '/workspace/notes.md', oldText: null, newText: 'Buy milk' },
        ],
        rawInput: undefined,
        rawOutput: undefined,
      },
    ]);
  });

  it('asks the user when the agent requests permission, and answers with the option they chose', async () => {
    const setup = setupAdapter(
      CursorAdapter.make,
      [
        [
          ...handshake,
          prompt(3, 'list them'),
          update({ sessionUpdate: 'tool_call', ...TOOL_CALL }),
          agentRequest(8, 'session/request_permission', { sessionId: SESSION, toolCall: { toolCallId: 'call_1' }, options: PERMISSION_OPTIONS }),
          answer(8, { outcome: { outcome: 'selected', optionId: 'proceed_once' } }),
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
          result(3, { stopReason: 'end_turn' }),
        ],
      ],
      undefined,
      () => 'proceed_once'
    );

    expect(await setup.prompt('list them')).toBe('end_turn');
    expect(setup.events.find((event) => event.type === 'permission_request')).toMatchObject({
      turnId: 'turn-1',
      requestId: 'permission-1',
      // The ask names the tool call the agent already opened, so the card belongs to it.
      toolCall: { toolCallId: 'call_1', status: 'pending' },
      options: PERMISSION_OPTIONS,
    });
    expect(setup.events).toContainEqual({
      type: 'permission_resolved',
      turnId: 'turn-1',
      requestId: 'permission-1',
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
  });

  it('leaves out options of kinds it does not know, and cancels an ask with none left', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'list them'),
        agentRequest(8, 'session/request_permission', {
          sessionId: SESSION,
          toolCall: { toolCallId: 'call_1', title: 'ls' },
          options: [{ optionId: 'ask_later', name: 'Ask later', kind: 'defer' }],
        }),
        answer(8, { outcome: { outcome: 'cancelled' } }),
        result(3, { stopReason: 'end_turn' }),
      ],
    ]);

    expect(await setup.prompt('list them')).toBe('end_turn');
    expect(setup.events.some((event) => event.type === 'permission_request')).toBe(false);
  });

  it('cancels an unanswered ask when the turn is stopped', async () => {
    const setup = setupAdapter(CursorAdapter.make, [
      [
        ...handshake,
        prompt(3, 'list them'),
        agentRequest(8, 'session/request_permission', { sessionId: SESSION, toolCall: { toolCallId: 'call_1', title: 'ls' }, options: PERMISSION_OPTIONS }),
        notify('session/cancel', { sessionId: SESSION }),
        answer(8, { outcome: { outcome: 'cancelled' } }),
        result(3, { stopReason: 'cancelled' }),
      ],
    ]);

    const turn = setup.prompt('list them');
    await vi.waitFor(() => expect(setup.events.some((event) => event.type === 'permission_request')).toBe(true));
    await Effect.runPromise(setup.adapter.cancel());

    expect(await turn).toBe('cancelled');
    expect(setup.events).toContainEqual({
      type: 'permission_resolved',
      turnId: 'turn-1',
      requestId: 'permission-1',
      outcome: { outcome: 'cancelled' },
    });
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

  describe('modes', () => {
    /** Starts a session whose agent offers `available` and runs in `agent` mode, taking request IDs 1 and 2. */
    const offering = (...available: string[]): TrafficLine[] => [
      ...initialize,
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
      result(2, { sessionId: SESSION, ...SESSION_CONFIG, modes: { currentModeId: 'agent', availableModes: available.map((id) => ({ id, name: id })) } }),
    ];
    const setMode = (id: number, modeId: string): TrafficLine[] => [request(id, 'session/set_mode', { sessionId: SESSION, modeId }), result(id, {})];

    it('switches a new session to the mode it maps to before the first prompt', async () => {
      const setup = setupAdapter(
        CursorAdapter.make,
        [[...offering('agent', 'plan', 'ask'), ...setMode(3, 'plan'), prompt(4, 'look'), result(4, { stopReason: 'end_turn' })]],
        undefined,
        undefined,
        { mode: 'plan' }
      );

      expect(await setup.prompt('look')).toBe('end_turn');
      expect(setup.events).toContainEqual({ type: 'session_configured', model: 'GPT-6', permissionMode: 'plan' });
    });

    it('leaves a session already in the mode it maps to as it is', async () => {
      const setup = setupAdapter(CursorAdapter.make, [[...offering('agent', 'plan'), prompt(3, 'hi'), result(3, { stopReason: 'end_turn' })]]);

      expect(await setup.prompt('hi')).toBe('end_turn');
      expect(setup.errors()).toEqual([]);
    });

    it('switches the open session straight away when the mode changes', async () => {
      const setup = setupAdapter(CursorAdapter.make, [
        [...offering('agent', 'plan'), prompt(3, 'hi'), result(3, { stopReason: 'end_turn' }), ...setMode(4, 'plan'), prompt(5, 'look'), result(5, { stopReason: 'end_turn' })],
      ]);

      expect(await setup.prompt('hi')).toBe('end_turn');
      await Effect.runPromise(setup.adapter.setMode('plan'));
      expect(await setup.prompt('look')).toBe('end_turn');
      expect(setup.errors()).toEqual([]);
    });

    it('fails, keeping its mode, when Cursor refuses to switch the open session', async () => {
      const setup = setupAdapter(CursorAdapter.make, [
        [
          ...offering('agent', 'plan'),
          prompt(3, 'hi'),
          result(3, { stopReason: 'end_turn' }),
          request(4, 'session/set_mode', { sessionId: SESSION, modeId: 'plan' }),
          rpcError(4, -32603, 'Cannot switch mode now'),
          prompt(5, 'again'),
          result(5, { stopReason: 'end_turn' }),
        ],
      ]);
      expect(await setup.prompt('hi')).toBe('end_turn');

      const refused = await Effect.runPromise(Effect.either(setup.adapter.setMode('plan')));

      expect(refused).toEqual(Either.left(new ModeChangeFailed({ agent: 'cursor', mode: 'plan', reason: 'Cannot switch mode now' })));
      // Still in Auto-edit, so the next prompt runs in the agent session mode it already has.
      expect(await setup.prompt('again')).toBe('end_turn');
    });

    it('ignores an override that would give a mode more freedom than its built-in setting', async () => {
      const setup = setupAdapter(
        CursorAdapter.make,
        [[...offering('agent', 'plan'), ...setMode(3, 'plan'), prompt(4, 'look'), result(4, { stopReason: 'end_turn' })]],
        undefined,
        undefined,
        { mode: 'plan', settings: modeSettings({ cursor: { plan: 'agent' } }) }
      );

      expect(await setup.prompt('look')).toBe('end_turn');
    });

    it('runs in the nearest more restrictive mode when the agent does not offer the one wanted', async () => {
      const setup = setupAdapter(
        CursorAdapter.make,
        [[...offering('agent', 'ask'), ...setMode(3, 'ask'), prompt(4, 'look'), result(4, { stopReason: 'end_turn' })]],
        undefined,
        undefined,
        { mode: 'plan' }
      );

      expect(await setup.prompt('look')).toBe('end_turn');
      expect(setup.errors()).toEqual([]);
    });

    it('fails the turn rather than run with more freedom when no restrictive enough mode is offered', async () => {
      const setup = setupAdapter(CursorAdapter.make, [[...offering('agent')]], undefined, undefined, { mode: 'plan' });

      expect(await setup.prompt('look')).toBe('error');
      expect(setup.errors()).toEqual([expect.objectContaining({ code: 'agent_error', message: expect.stringContaining('Plan') })]);
    });

    it('uses the session mode the modeOverrides setting names, and ignores an invalid setting', async () => {
      const overridden = setupAdapter(
        CursorAdapter.make,
        [[...offering('agent', 'plan', 'ask'), ...setMode(3, 'ask'), prompt(4, 'hi'), result(4, { stopReason: 'end_turn' })]],
        undefined,
        undefined,
        { settings: modeSettings({ cursor: { auto_edit: 'ask' } }) }
      );
      expect(await overridden.prompt('hi')).toBe('end_turn');

      const invalid = setupAdapter(
        CursorAdapter.make,
        [[...offering('agent', 'plan', 'ask'), prompt(3, 'hi'), result(3, { stopReason: 'end_turn' })]],
        undefined,
        undefined,
        { settings: modeSettings({ cursor: { auto_edit: 42 } }) }
      );
      expect(await invalid.prompt('hi')).toBe('end_turn');
      expect([...overridden.errors(), ...invalid.errors()]).toEqual([]);
    });

    it('allows every permission request in Full auto without asking the user', async () => {
      const setup = setupAdapter(
        CursorAdapter.make,
        [
          [
            ...handshake,
            prompt(3, 'list them'),
            update({ sessionUpdate: 'tool_call', ...TOOL_CALL }),
            agentRequest(8, 'session/request_permission', { sessionId: SESSION, toolCall: { toolCallId: 'call_1' }, options: PERMISSION_OPTIONS }),
            answer(8, { outcome: { outcome: 'selected', optionId: 'proceed_once' } }),
            update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
            result(3, { stopReason: 'end_turn' }),
          ],
        ],
        undefined,
        undefined,
        { mode: 'full_auto' }
      );

      expect(await setup.prompt('list them')).toBe('end_turn');
      expect(setup.events.map((event) => event.type)).not.toContain('permission_request');
    });

    it('asks the user in Full auto when the agent offers no allow-once option, rather than always allow', async () => {
      const options = PERMISSION_OPTIONS.filter((option) => option.kind !== 'allow_once');
      const setup = setupAdapter(
        CursorAdapter.make,
        [
          [
            ...handshake,
            prompt(3, 'list them'),
            update({ sessionUpdate: 'tool_call', ...TOOL_CALL }),
            agentRequest(8, 'session/request_permission', { sessionId: SESSION, toolCall: { toolCallId: 'call_1' }, options }),
            answer(8, { outcome: { outcome: 'selected', optionId: 'reject_once' } }),
            result(3, { stopReason: 'end_turn' }),
          ],
        ],
        undefined,
        () => 'reject_once',
        { mode: 'full_auto' }
      );

      expect(await setup.prompt('list them')).toBe('end_turn');
      expect(setup.events.find((event) => event.type === 'permission_request')).toMatchObject({ options });
    });
  });
});
