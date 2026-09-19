import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Effect, Either, Exit, Layer, Option, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { Ids } from '../../ids';
import { recordingSink, type Answer } from '../../testing/eventSink';
import { TurnInProgress, UnknownPermissionRequest } from '../adapter';
import type { AgentEvent } from '../events';
import { Executables } from '../findExecutable';
import type { TrafficLine, WireMessage } from '../traffic';
import { ClaudeAdapter, ClaudeSdk } from './claudeAdapter';
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

function assistant(id: string, text: string) {
  return { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } };
}

function toolUse(messageId: string, toolUseId: string, name: string, input: WireMessage) {
  return { type: 'assistant', parent_tool_use_id: null, message: { id: messageId, content: [{ type: 'tool_use', id: toolUseId, name, input }] } };
}

function toolResult(toolUseId: string, content: WireMessage, isError = false) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

/** Claude asking permission for a tool, and the answer the adapter is expected to send back. */
const asks = (requestId: string, name: string, input: WireMessage, extra: { readonly [key: string]: WireMessage } = {}): TrafficLine => ({
  dir: 'recv',
  data: {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: name, input, options: { toolUseID: 'toolu_1', requestId, ...extra } },
  },
});

const answers = (requestId: string, response: WireMessage): TrafficLine => ({
  dir: 'send',
  data: { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } },
});

function result(fields: { is_error?: boolean; result?: string } = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', ...fields };
}

interface SetupOptions {
  executablePath?: Option.Option<string>;
  /** Resolves `claude` given the configured override; defaults to finding it. */
  findClaude?: (override: Option.Option<string>) => Option.Option<string>;
  /** How the user answers a permission request; no answer leaves the request open. */
  answer?: Answer;
}

/**
 * Builds an adapter over a fake agent, in a scope the test can close, capturing the events it emits
 * and the options it starts Claude with.
 */
function setup(
  traffic: TrafficLine[][],
  { executablePath = Option.none(), findClaude = () => Option.some('/usr/local/bin/claude'), answer }: SetupOptions = {}
) {
  const events: AgentEvent[] = [];
  const started: Options[] = [];
  const sessions = [...traffic];
  let id = 0;
  const services = Layer.mergeAll(
    Layer.succeed(ClaudeSdk, {
      query: (params) => {
        started.push(params.options);
        return replayQuery(sessions.shift() ?? [])(params);
      },
    }),
    Layer.succeed(Executables, { find: (_name, override) => Effect.sync(() => findClaude(override)) }),
    Layer.succeed(Ids, { next: Effect.sync(() => (id++ === 0 ? SESSION_ID : `turn-${id - 1}`)) })
  );
  const scope = Effect.runSync(Scope.make());
  // The sink reaches the adapter to answer its asks, and only ever runs once it has been built.
  let built: ClaudeAdapter | undefined;
  built = Effect.runSync(
    ClaudeAdapter.make({ cwd: '/workspace', executablePath, onEvent: recordingSink(events, answer, () => built) }).pipe(
      Scope.extend(scope),
      Effect.provide(services)
    )
  );
  const adapter = built;
  const prompt = (text: string) => Effect.runPromise(adapter.prompt([{ type: 'text', text }]));
  const dispose = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return { adapter, events, started, prompt, dispose };
}

/** The tool call updates in the events, as the adapter sent them. */
const toolUpdates = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === 'session_update' && (event.update.sessionUpdate === 'tool_call' || event.update.sessionUpdate === 'tool_call_update')
      ? [event.update]
      : []
  );

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

  it('shows a tool call Claude ran without asking, and what it returned', async () => {
    const { events, prompt } = setup([
      [
        { dir: 'send', data: userMessage('read it') },
        { dir: 'recv', data: toolUse('msg_1', 'toolu_1', 'Read', { file_path: '/workspace/notes.md' }) },
        { dir: 'recv', data: toolResult('toolu_1', 'Buy milk') },
        { dir: 'recv', data: result() },
      ],
    ]);

    expect(await prompt('read it')).toBe('end_turn');
    expect(toolUpdates(events)).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_1',
        title: 'Read /workspace/notes.md',
        kind: 'read',
        status: 'in_progress',
        rawInput: { file_path: '/workspace/notes.md' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Buy milk' } }],
      },
    ]);
  });

  it('asks the user before a tool Claude needs permission for, and allows it', async () => {
    const { events, prompt } = setup(
      [
        [
          { dir: 'send', data: userMessage('list them') },
          asks('req_1', 'Bash', { command: 'ls' }),
          answers('req_1', { behavior: 'allow', updatedInput: { command: 'ls' } }),
          { dir: 'recv', data: toolUse('msg_1', 'toolu_1', 'Bash', { command: 'ls' }) },
          { dir: 'recv', data: toolResult('toolu_1', 'notes.md') },
          { dir: 'recv', data: result() },
        ],
      ],
      { answer: () => 'allow' }
    );

    expect(await prompt('list them')).toBe('end_turn');
    const request = events.find((event) => event.type === 'permission_request');
    expect(request).toMatchObject({
      turnId: 'turn-1',
      requestId: 'permission-1',
      toolCall: { toolCallId: 'toolu_1', title: 'ls', kind: 'execute', status: 'pending' },
      // Claude suggested no permission rule, so there is nothing "Always" could remember.
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    expect(events).toContainEqual({
      type: 'permission_resolved',
      turnId: 'turn-1',
      requestId: 'permission-1',
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    // The ask shows the tool call; the tool use that follows it does not show it again.
    expect(toolUpdates(events).map((update) => [update.sessionUpdate, update.status])).toEqual([
      ['tool_call', 'pending'],
      ['tool_call_update', 'in_progress'],
      ['tool_call_update', 'completed'],
    ]);
  });

  it('offers Always only when Claude suggests a rule that would stop it asking', async () => {
    const { events, prompt } = setup(
      [
        [
          { dir: 'send', data: userMessage('list them') },
          asks('req_1', 'Bash', { command: 'ls' }, { suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }),
          answers('req_1', {
            behavior: 'allow',
            updatedInput: { command: 'ls' },
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
          }),
          { dir: 'recv', data: result() },
        ],
      ],
      { answer: () => 'allow_always' }
    );

    expect(await prompt('list them')).toBe('end_turn');
    expect(events.find((event) => event.type === 'permission_request')?.options.map((option) => option.optionId)).toEqual([
      'allow',
      'allow_always',
      'deny',
    ]);
  });

  it('denies the tool when the user says no, and shows the call as failed', async () => {
    const { events, prompt } = setup(
      [
        [
          { dir: 'send', data: userMessage('remove it') },
          asks('req_1', 'Bash', { command: 'rm -rf /' }),
          answers('req_1', { behavior: 'deny', message: 'The user denied this tool call.' }),
          { dir: 'recv', data: result() },
        ],
      ],
      { answer: () => 'deny' }
    );

    expect(await prompt('remove it')).toBe('end_turn');
    expect(toolUpdates(events).at(-1)).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'failed' });
  });

  it('cancels an unanswered ask when the turn is stopped', async () => {
    const { adapter, events, prompt } = setup([
      [
        { dir: 'send', data: userMessage('list them') },
        asks('req_1', 'Bash', { command: 'ls' }),
        answers('req_1', { behavior: 'deny', message: 'The turn was stopped before the user answered.', interrupt: true }),
        { dir: 'recv', data: result() },
      ],
    ]);

    const turn = prompt('list them');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission_request')).toBe(true));
    await Effect.runPromise(adapter.cancel());

    expect(await turn).toBe('cancelled');
    expect(events).toContainEqual({ type: 'permission_resolved', turnId: 'turn-1', requestId: 'permission-1', outcome: { outcome: 'cancelled' } });
  });

  it('cancels an unanswered ask when the thread closes, and refuses answers after it', async () => {
    const { adapter, events, prompt, dispose } = setup([
      [
        { dir: 'send', data: userMessage('list them') },
        asks('req_1', 'Bash', { command: 'ls' }),
        answers('req_1', { behavior: 'deny', message: 'The turn was stopped before the user answered.', interrupt: true }),
      ],
    ]);

    const turn = prompt('list them');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission_request')).toBe(true));
    await dispose();

    expect(await turn).toBe('cancelled');
    expect(events).toContainEqual({ type: 'permission_resolved', turnId: 'turn-1', requestId: 'permission-1', outcome: { outcome: 'cancelled' } });
    const late = await Effect.runPromise(Effect.either(adapter.respond('permission-1', 'allow')));
    expect(late).toEqual(Either.left(new UnknownPermissionRequest({ requestId: 'permission-1', optionId: 'allow' })));
  });

  it('refuses an answer that names an option the request never offered', async () => {
    const { adapter, events, prompt } = setup(
      [[{ dir: 'send', data: userMessage('list them') }, asks('req_1', 'Bash', { command: 'ls' })]],
      {}
    );

    void prompt('list them');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission_request')).toBe(true));

    const answer = await Effect.runPromise(Effect.either(adapter.respond('permission-1', 'allow_always')));
    expect(answer).toEqual(Either.left(new UnknownPermissionRequest({ requestId: 'permission-1', optionId: 'allow_always' })));
  });

  it('reports a missing binary in the thread instead of starting Claude', async () => {
    const { events, started, prompt } = setup([], { findClaude: () => Option.none() });

    expect(await prompt('hi')).toBe('error');
    expect(started).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ code: 'binary_missing', message: expect.stringContaining('not found on PATH') }),
      expect.objectContaining({ code: 'binary_missing', turnId: 'turn-1' }),
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'error' });
  });

  it('names the configured path when the executablePath setting is wrong', () => {
    let override: Option.Option<string> = Option.none();
    const { events } = setup([], {
      executablePath: Option.some('/opt/claude'),
      findClaude: (path) => ((override = path), Option.none()),
    });

    expect(override).toEqual(Option.some('/opt/claude'));
    expect(events[1]).toMatchObject({ code: 'binary_missing', message: expect.stringContaining('"/opt/claude"') });
  });

  it('reports the first error of a turn only once', async () => {
    const { events, prompt } = setup([
      [
        { dir: 'send', data: userMessage('hi') },
        { dir: 'recv', data: { ...assistant('msg_1', 'API Error: 529 Overloaded'), error: 'overloaded' } },
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

  it('refuses a second prompt while a turn is running', async () => {
    const { adapter, prompt } = setup([[{ dir: 'send', data: userMessage('hi') }]]);

    void prompt('hi');
    const second = await Effect.runPromise(Effect.either(adapter.prompt([{ type: 'text', text: 'again' }])));
    expect(second).toEqual(Either.left(new TurnInProgress({ agent: 'claude' })));
  });

  it('ends a running turn as cancelled when disposed', async () => {
    const { events, prompt, dispose } = setup([[{ dir: 'send', data: userMessage('hi') }]]);

    const turn = prompt('hi');
    await dispose();
    expect(await turn).toBe('cancelled');
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });
});
