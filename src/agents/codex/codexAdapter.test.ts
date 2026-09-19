import { Effect, Either, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { agentRequest, exit, methodNotFound, notification, notify, request, result, setupAdapter } from '../../testing/stdioFixtures';
import { TurnInProgress } from '../adapter';
import { CLIENT_INFO } from '../jsonRpcAdapter';
import type { TrafficLine, WireMessage } from '../traffic';
import { CodexAdapter } from './codexAdapter';

const THREAD = 'thread-a';
const TURN = 'codex-turn-1';

/** Starts `codex app-server` and a thread, taking request IDs 1 to 3. */
function handshake(open: TrafficLine = request(3, 'thread/start', { cwd: '/workspace' })): TrafficLine[] {
  return [
    request(1, 'initialize', { clientInfo: CLIENT_INFO, capabilities: null }),
    result(1, { userAgent: 'codex' }),
    notify('initialized'),
    request(2, 'account/read', {}),
    result(2, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
    open,
    result(3, { thread: { id: THREAD }, model: 'gpt-6', approvalPolicy: 'on-request' }),
  ];
}

function turnStart(id: number, text: string): TrafficLine[] {
  return [
    request(id, 'turn/start', { threadId: THREAD, input: [{ type: 'text', text, text_elements: [] }] }),
    result(id, { turn: { id: TURN } }),
  ];
}

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
        agentRequest(0, 'item/commandExecution/requestApproval', { threadId: THREAD }),
        methodNotFound(0, 'item/commandExecution/requestApproval'),
        turnCompleted('completed'),
      ],
    ]);

    expect(await prompt('hi')).toBe('end_turn');
    expect(errors()).toEqual([]);
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
});
