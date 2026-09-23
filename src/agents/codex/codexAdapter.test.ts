import { Effect, Either, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { modeSettings } from '../../testing/modeSettings';
import { agentRequest, answer, exit, methodNotFound, notification, notify, request, result, rpcError, setupAdapter } from '../../testing/stdioFixtures';
import { TurnInProgress } from '../adapter';
import { CLIENT_INFO } from '../jsonRpcSession';
import type { TrafficLine, WireMessage } from '../traffic';
import { CodexAdapter } from './codexAdapter';

const THREAD = 'thread-a';
const TURN = 'codex-turn-1';

/** Starts `codex app-server` and a thread, taking request IDs 1 to 3. */
function handshake(open: TrafficLine = request(3, 'thread/start', { cwd: '/workspace' }), model = 'gpt-6'): TrafficLine[] {
  return [
    request(1, 'initialize', { clientInfo: CLIENT_INFO, capabilities: null }),
    result(1, { userAgent: 'codex' }),
    notify('initialized'),
    request(2, 'account/read', {}),
    result(2, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
    open,
    result(3, { thread: { id: THREAD }, model, approvalPolicy: 'on-request' }),
  ];
}

/** What a turn tells Codex about when to ask and what it may touch. */
interface TurnPolicy {
  readonly approvalPolicy: string;
  readonly sandboxPolicy: WireMessage;
}

/** Auto-edit, the mode adapters start in: Codex asks before edits and commands, and writes only to the workspace. */
const AUTO_EDIT: TurnPolicy = {
  approvalPolicy: 'untrusted',
  sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};

function turnStart(id: number, text: string, policy: TurnPolicy = AUTO_EDIT): TrafficLine[] {
  return [
    request(id, 'turn/start', { threadId: THREAD, input: [{ type: 'text', text, text_elements: [] }], ...policy }),
    result(id, { turn: { id: TURN } }),
  ];
}

const started = (item: WireMessage, threadId = THREAD) => notification('item/started', { threadId, turnId: TURN, item });
const command = (status: string, output: WireMessage = null, exitCode: WireMessage = null): WireMessage => ({
  type: 'commandExecution',
  id: 'cmd_1',
  command: 'ls',
  cwd: '/workspace',
  status,
  aggregatedOutput: output,
  exitCode,
});
const requestApproval = (id: number, method: string, params: { readonly [key: string]: WireMessage }) =>
  agentRequest(id, method, { threadId: THREAD, turnId: TURN, startedAtMs: 0, ...params });

const delta = (itemId: string, text: string, threadId = THREAD) =>
  notification('item/agentMessage/delta', { threadId, turnId: TURN, itemId, delta: text });
const completed = (item: WireMessage, threadId = THREAD) => notification('item/completed', { threadId, turnId: TURN, item });
const turnCompleted = (status: string, error: WireMessage = null) =>
  notification('turn/completed', { threadId: THREAD, turn: { id: TURN, status, error } });

describe('CodexAdapter', () => {
  it('starts `codex app-server` with the first prompt and announces the thread Codex creates', async () => {
    const { events, spawned, prompt } = setupAdapter(CodexAdapter.make, [[...handshake(), ...turnStart(4, 'hi'), turnCompleted('completed')]]);
    expect(spawned).toEqual([]);

    expect(await prompt('hi')).toBe('end_turn');
    expect(spawned).toEqual([{ executable: '/usr/local/bin/codex', args: ['app-server'], cwd: '/workspace' }]);
    expect(events.map((event) => event.type)).toEqual(['turn_started', 'session_started', 'session_configured', 'turn_ended']);
    expect(events[1]).toEqual({ type: 'session_started', agent: 'codex', sessionId: THREAD });
    expect(events[2]).toEqual({ type: 'session_configured', model: 'gpt-6', permissionMode: 'on-request' });
  });

  it('passes a requested model when creating a Codex thread', async () => {
    const setup = setupAdapter(CodexAdapter.make, [[
      ...handshake(request(3, 'thread/start', { cwd: '/workspace', model: 'gpt-6-astra' })),
      ...turnStart(4, 'hi'),
      turnCompleted('completed'),
    ]], undefined, undefined, { model: 'gpt-6-astra' });

    expect(await setup.prompt('hi')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
  });

  it('uses a newly selected model on the next turn', async () => {
    const setup = setupAdapter(CodexAdapter.make, [[
      ...handshake(), ...turnStart(4, 'one'), turnCompleted('completed'),
      request(5, 'turn/start', {
        threadId: THREAD, input: [{ type: 'text', text: 'two', text_elements: [] }], ...AUTO_EDIT, model: 'gpt-6-astra',
      }),
      result(5, { turn: { id: TURN } }), turnCompleted('completed'),
    ]]);
    expect(await setup.prompt('one')).toBe('end_turn');
    await Effect.runPromise(setup.adapter.setModel('gpt-6-astra'));
    expect(await setup.prompt('two')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
  });

  it('returns to the catalog default after a thread began with an explicit model', async () => {
    const setup = setupAdapter(CodexAdapter.make, [[
      ...handshake(request(3, 'thread/start', { cwd: '/workspace', model: 'gpt-6-astra' }), 'gpt-6-astra'),
      ...turnStart(4, 'one'), turnCompleted('completed'),
      request(5, 'model/list', {}),
      result(5, { data: [
        { model: 'gpt-6-astra', isDefault: false },
        { model: 'gpt-6-sol', isDefault: true },
      ], nextCursor: null }),
      request(6, 'turn/start', {
        threadId: THREAD, input: [{ type: 'text', text: 'two', text_elements: [] }], ...AUTO_EDIT, model: 'gpt-6-sol',
      }),
      result(6, { turn: { id: TURN } }), turnCompleted('completed'),
    ]], undefined, undefined, { model: 'gpt-6-astra' });
    expect(await setup.prompt('one')).toBe('end_turn');
    await Effect.runPromise(setup.adapter.setModel(undefined));
    expect(await setup.prompt('two')).toBe('end_turn');
    expect(setup.errors()).toEqual([]);
  });

  it('streams agent message and reasoning deltas, and shows completed items that never streamed', async () => {
    const { chunks, errors, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'count'),
        notification('item/reasoning/summaryTextDelta', { threadId: THREAD, turnId: TURN, itemId: 'rs_1', summaryIndex: 0, delta: 'Counting' }),
        delta('msg_1', '1'),
        delta('msg_1', '\n2'),
        completed({ type: 'agentMessage', id: 'msg_1', text: '1\n2' }),
        completed({ type: 'agentMessage', id: 'msg_2', text: 'Done.' }),
        completed({ type: 'commandExecution', id: 'cmd_1' }),
        turnCompleted('completed'),
      ],
    ]);

    expect(await prompt('count')).toBe('end_turn');
    expect(errors()).toEqual([]);
    expect(chunks()).toEqual([
      ['agent_thought_chunk', 'rs_1:0', 'Counting'],
      ['agent_message_chunk', 'msg_1', '1'],
      ['agent_message_chunk', 'msg_1', '\n2'],
      ['agent_message_chunk', 'msg_2', 'Done.'],
    ]);
  });

  it('skips items of other threads, such as sub-agents', async () => {
    const { chunks, prompt } = setupAdapter(CodexAdapter.make, [
      [...handshake(), ...turnStart(4, 'hi'), delta('msg_sub', 'inner', 'thread-sub'), delta('msg_1', 'outer'), turnCompleted('completed')],
    ]);

    await prompt('hi');
    expect(chunks()).toEqual([['agent_message_chunk', 'msg_1', 'outer']]);
  });

  it('reports the error that fails a turn once, and not the retries before it', async () => {
    const failure = (message: string, willRetry: boolean) =>
      notification('error', {
        threadId: THREAD,
        turnId: TURN,
        willRetry,
        error: { message, codexErrorInfo: 'serverOverloaded', additionalDetails: null },
      });
    const { errors, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'hi'),
        failure('Reconnecting... 1/5', true),
        failure('Overloaded', false),
        turnCompleted('failed', { message: 'Overloaded', codexErrorInfo: 'serverOverloaded', additionalDetails: null }),
      ],
    ]);

    expect(await prompt('hi')).toBe('error');
    expect(errors()).toEqual([{ type: 'error', turnId: 'turn-1', code: 'agent_error', message: 'Overloaded' }]);
  });

  it('declines requests it does not support with "method not found"', async () => {
    const { errors, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'hi'),
        agentRequest(0, 'item/tool/requestUserInput', { threadId: THREAD }),
        methodNotFound(0, 'item/tool/requestUserInput'),
        turnCompleted('completed'),
      ],
    ]);

    expect(await prompt('hi')).toBe('end_turn');
    expect(errors()).toEqual([]);
  });

  it('shows a command Codex ran, with its output and exit code', async () => {
    const { toolUpdates, errors, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'list them'),
        started(command('inProgress')),
        completed(command('completed', 'notes.md', 0)),
        turnCompleted('completed'),
      ],
    ]);

    expect(await prompt('list them')).toBe('end_turn');
    expect(errors()).toEqual([]);
    expect(toolUpdates()).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'cmd_1', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls', cwd: '/workspace' } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd_1',
        title: 'ls',
        kind: 'execute',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'notes.md' } }],
        rawInput: { command: 'ls', cwd: '/workspace' },
        rawOutput: { exitCode: 0 },
      },
    ]);
  });

  it('asks the user before a command Codex wants approved, and sends back the decision', async () => {
    const { events, prompt } = setupAdapter(
      CodexAdapter.make,
      [
        [
          ...handshake(),
          ...turnStart(4, 'list them'),
          started(command('inProgress')),
          requestApproval(0, 'item/commandExecution/requestApproval', { itemId: 'cmd_1', command: 'ls', cwd: '/workspace', kind: 'command', environmentId: null }),
          answer(0, { decision: 'acceptForSession' }),
          completed(command('completed', 'notes.md', 0)),
          turnCompleted('completed'),
        ],
      ],
      undefined,
      () => 'acceptForSession'
    );

    expect(await prompt('list them')).toBe('end_turn');
    expect(events.find((event) => event.type === 'permission_request')).toMatchObject({
      turnId: 'turn-1',
      requestId: 'permission-1',
      toolCall: { toolCallId: 'cmd_1', title: 'ls', kind: 'execute', status: 'pending' },
      options: [
        { optionId: 'accept', kind: 'allow_once' },
        { optionId: 'acceptForSession', kind: 'allow_always' },
        { optionId: 'decline', kind: 'reject_once' },
      ],
    });
    expect(events).toContainEqual({
      type: 'permission_resolved',
      turnId: 'turn-1',
      requestId: 'permission-1',
      outcome: { outcome: 'selected', optionId: 'acceptForSession' },
    });
  });

  it('offers the decisions the request advertises, and sends back the one the user chose', async () => {
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/zsh', '-lc', 'printf hi'] } };
    const { events, prompt } = setupAdapter(
      CodexAdapter.make,
      [
        [
          ...handshake(),
          ...turnStart(4, 'write it'),
          requestApproval(0, 'item/commandExecution/requestApproval', {
            itemId: 'cmd_1',
            command: '/bin/zsh -lc \'printf hi\'',
            kind: 'command',
            environmentId: null,
            // This request takes neither acceptForSession nor decline.
            availableDecisions: ['accept', amendment, 'cancel'],
          }),
          answer(0, { decision: amendment }),
          turnCompleted('completed'),
        ],
      ],
      undefined,
      (options) => options.find((option) => option.kind === 'allow_always')?.optionId
    );

    expect(await prompt('write it')).toBe('end_turn');
    expect(events.find((event) => event.type === 'permission_request')?.options).toEqual([
      { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'acceptWithExecpolicyAmendment', name: 'Always allow this command', kind: 'allow_always' },
      // Nothing in the request refuses the command, so cancelling it is offered instead.
      { optionId: 'cancel', name: 'Deny', kind: 'reject_once' },
    ]);
  });

  it('refuses with the decision the request offers for it', async () => {
    const { events, prompt } = setupAdapter(
      CodexAdapter.make,
      [
        [
          ...handshake(),
          ...turnStart(4, 'write it'),
          requestApproval(0, 'item/fileChange/requestApproval', { itemId: 'patch_1', availableDecisions: ['accept', 'decline', 'cancel'] }),
          answer(0, { decision: 'decline' }),
          turnCompleted('completed'),
        ],
      ],
      undefined,
      () => 'decline'
    );

    expect(await prompt('write it')).toBe('end_turn');
    expect(events.find((event) => event.type === 'permission_request')?.options.map((option) => option.optionId)).toEqual(['accept', 'decline']);
  });

  it('names the host when Codex asks to reach the network, and passes a refusal on', async () => {
    const { events, prompt } = setupAdapter(
      CodexAdapter.make,
      [
        [
          ...handshake(),
          ...turnStart(4, 'fetch it'),
          requestApproval(0, 'item/commandExecution/requestApproval', {
            itemId: 'cmd_1',
            command: 'curl https://example.com',
            kind: 'command',
            environmentId: null,
            networkApprovalContext: { host: 'example.com', protocol: 'https' },
          }),
          answer(0, { decision: 'decline' }),
          turnCompleted('completed'),
        ],
      ],
      undefined,
      () => 'decline'
    );

    expect(await prompt('fetch it')).toBe('end_turn');
    expect(events.find((event) => event.type === 'permission_request')?.toolCall).toMatchObject({
      title: 'Allow network access to example.com',
      kind: 'fetch',
    });
  });

  it('cancels an unanswered approval when the turn is stopped', async () => {
    const { adapter, events, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'list them'),
        requestApproval(0, 'item/fileChange/requestApproval', { itemId: 'patch_1' }),
        // Codex is interrupted first, and the approval it is waiting on is answered as cancelled.
        request(5, 'turn/interrupt', { threadId: THREAD, turnId: TURN }),
        result(5, {}),
        answer(0, { decision: 'cancel' }),
        turnCompleted('interrupted'),
      ],
    ]);

    const turn = prompt('list them');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission_request')).toBe(true));
    await Effect.runPromise(adapter.cancel());

    expect(await turn).toBe('cancelled');
    expect(events).toContainEqual({ type: 'permission_resolved', turnId: 'turn-1', requestId: 'permission-1', outcome: { outcome: 'cancelled' } });
  });

  it('interrupts the running turn when cancelled', async () => {
    const { adapter, chunks, errors, prompt } = setupAdapter(CodexAdapter.make, [
      [
        ...handshake(),
        ...turnStart(4, 'hi'),
        delta('msg_1', 'Working'),
        request(5, 'turn/interrupt', { threadId: THREAD, turnId: TURN }),
        result(5, {}),
        turnCompleted('interrupted'),
      ],
    ]);

    const turn = prompt('hi');
    await vi.waitFor(() => expect(chunks()).toHaveLength(1));
    await Effect.runPromise(adapter.cancel());
    expect(await turn).toBe('cancelled');
    expect(errors()).toEqual([]);
  });

  it('never sends a prompt cancelled while Codex was starting', async () => {
    const { adapter, events, errors, prompt } = setupAdapter(CodexAdapter.make, [handshake()]);

    const turn = prompt('hi');
    await Effect.runPromise(adapter.cancel());
    expect(await turn).toBe('cancelled');
    expect(errors()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'cancelled' });
  });

  it('ends the connection with a crash when Codex sends a malformed message', async () => {
    const { errors, prompt } = setupAdapter(CodexAdapter.make, [
      [...handshake(), ...turnStart(4, 'hi'), notification('item/agentMessage/delta', { threadId: THREAD, itemId: 'msg_1' })],
    ]);

    expect(await prompt('hi')).toBe('error');
    expect(errors()).toEqual([
      expect.objectContaining({ turnId: 'turn-1', code: 'process_crashed', message: expect.stringContaining('malformed item/agentMessage/delta notification') }),
    ]);
  });

  it('ends the connection with a crash when Codex writes a line that is not JSON-RPC', async () => {
    const { errors, prompt } = setupAdapter(CodexAdapter.make, [[...handshake(), ...turnStart(4, 'hi'), { dir: 'recv', data: 'panic!' }]]);

    expect(await prompt('hi')).toBe('error');
    expect(errors()).toEqual([expect.objectContaining({ code: 'process_crashed', message: 'Codex stopped unexpectedly: sent a line that is not JSON-RPC: panic!' })]);
  });

  it('reports a crash, then resumes the thread in a new process on the next prompt', async () => {
    const { events, errors, spawned, prompt } = setupAdapter(CodexAdapter.make, [
      [...handshake(), ...turnStart(4, 'first'), exit('the process exited with code 1\n\nthread panicked')],
      [...handshake(request(3, 'thread/resume', { threadId: THREAD })), ...turnStart(4, 'second'), turnCompleted('completed')],
    ]);

    expect(await prompt('first')).toBe('error');
    expect(errors()).toEqual([
      {
        type: 'error',
        turnId: 'turn-1',
        code: 'process_crashed',
        message: 'Codex stopped unexpectedly: the process exited with code 1\n\nthread panicked',
      },
    ]);

    expect(await prompt('second')).toBe('end_turn');
    expect(spawned).toHaveLength(2);
    // The thread is the same one, so it is not announced again.
    expect(events.filter((event) => event.type === 'session_started')).toHaveLength(1);
  });

  it('resumes a stored thread with its first prompt, keeping the model the thread had selected', async () => {
    const { events, errors, prompt } = setupAdapter(CodexAdapter.make, [[
      ...handshake(request(3, 'thread/resume', { threadId: THREAD })),
      request(4, 'turn/start', { threadId: THREAD, input: [{ type: 'text', text: 'again', text_elements: [] }], ...AUTO_EDIT, model: 'gpt-6-astra' }),
      result(4, { turn: { id: TURN } }),
      turnCompleted('completed'),
    ]], undefined, undefined, { resume: THREAD, model: 'gpt-6-astra' });

    expect(await prompt('again')).toBe('end_turn');
    expect(errors()).toEqual([]);
    // The stored thread is already known, so it is not announced again.
    expect(events.filter((event) => event.type === 'session_started')).toEqual([]);
  });

  it('fails the resume when Codex refuses the stored thread, and never starts another', async () => {
    const { errors, spawned, prompt } = setupAdapter(CodexAdapter.make, [[
      ...handshake(request(3, 'thread/resume', { threadId: THREAD })).slice(0, -1),
      rpcError(3, -32600, 'no rollout found for thread id thread-a'),
    ]], undefined, undefined, { resume: THREAD });

    expect(await prompt('again')).toBe('error');
    expect(spawned).toHaveLength(1);
    expect(errors()).toEqual([
      expect.objectContaining({ code: 'resume_failed', message: expect.stringContaining('no rollout found for thread id thread-a') }),
    ]);
  });

  it('reports a missing binary in the thread instead of starting Codex', async () => {
    const { errors, spawned, prompt } = setupAdapter(CodexAdapter.make, [], () => Option.none());

    expect(await prompt('hi')).toBe('error');
    expect(spawned).toEqual([]);
    expect(errors()).toEqual([
      expect.objectContaining({ code: 'binary_missing', message: expect.stringContaining('Codex ("codex") was not found on PATH') }),
      expect.objectContaining({ code: 'binary_missing', turnId: 'turn-1' }),
    ]);
  });

  it('refuses a second prompt while a turn is running', async () => {
    const { adapter, prompt } = setupAdapter(CodexAdapter.make, [[...handshake(), ...turnStart(4, 'hi')]]);

    void prompt('hi');
    const second = await Effect.runPromise(Effect.either(adapter.prompt([{ type: 'text', text: 'again' }])));
    expect(second).toEqual(Either.left(new TurnInProgress({ agent: 'codex' })));
  });

  it('ends a running turn as cancelled when disposed', async () => {
    const { errors, prompt, dispose } = setupAdapter(CodexAdapter.make, [[...handshake(), ...turnStart(4, 'hi')]]);

    const turn = prompt('hi');
    await Effect.runPromise(Effect.yieldNow());
    await dispose();
    expect(await turn).toBe('cancelled');
    expect(errors()).toEqual([]);
  });

  describe('modes', () => {
    const PLAN: TurnPolicy = { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };

    it('starts each turn with the policy of the mode it starts in', async () => {
      const { prompt } = setupAdapter(CodexAdapter.make, [[...handshake(), ...turnStart(4, 'look', PLAN), turnCompleted('completed')]], undefined, undefined, {
        mode: 'plan',
      });

      expect(await prompt('look')).toBe('end_turn');
    });

    it('applies a mode changed between turns from the next turn', async () => {
      const { adapter, errors, prompt } = setupAdapter(CodexAdapter.make, [
        [...handshake(), ...turnStart(4, 'one'), turnCompleted('completed'), ...turnStart(5, 'two', PLAN), turnCompleted('completed')],
      ]);

      expect(await prompt('one')).toBe('end_turn');
      await Effect.runPromise(adapter.setMode('plan'));
      expect(await prompt('two')).toBe('end_turn');
      expect(errors()).toEqual([]);
    });

    it('uses the policy the modeOverrides setting names for a mode', async () => {
      const override = { approvalPolicy: 'on-request', sandbox: 'read-only' };
      const { errors, prompt } = setupAdapter(
        CodexAdapter.make,
        [
          [
            ...handshake(),
            ...turnStart(4, 'look', { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
            turnCompleted('completed'),
          ],
        ],
        undefined,
        undefined,
        { mode: 'plan', settings: modeSettings({ codex: { plan: override } }) }
      );

      expect(await prompt('look')).toBe('end_turn');
      expect(errors()).toEqual([]);
    });

    it('falls back to the built-in policy when the modeOverrides setting is invalid', async () => {
      const { errors, prompt } = setupAdapter(
        CodexAdapter.make,
        [[...handshake(), ...turnStart(4, 'look', PLAN), turnCompleted('completed')]],
        undefined,
        undefined,
        { mode: 'plan', settings: modeSettings({ codex: { plan: { approvalPolicy: 'sometimes', sandbox: 'read-only' } } }) }
      );

      expect(await prompt('look')).toBe('end_turn');
      expect(errors()).toEqual([]);
    });
  });
});
