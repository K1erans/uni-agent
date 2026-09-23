import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events';
import type { ExtensionMessage, ThreadInfo } from '../../src/protocol';
import { createMemoryTransport } from './memoryTransport';
import { createSidebarClient, type PromptOutcome } from './sidebarClient';

const THREAD: ThreadInfo = { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' };
const OTHER: ThreadInfo = { id: 'thread-2', agent: 'codex', workspace: null };

const history = (thread: ThreadInfo, events: AgentEvent[] = [], readOnly: string | null = null): ExtensionMessage => ({
  type: 'history',
  thread,
  mode: 'auto_edit',
  model: null,
  readOnly,
  events: events.map((event) => ({ event, at: 0 })),
});
const turnStarted: AgentEvent = { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Go' }] };

/** A client on an in-memory transport, showing `thread` unless it is null. */
function connect(thread: ThreadInfo | null = THREAD) {
  const extension = createMemoryTransport();
  const client = createSidebarClient(extension);
  if (thread) {
    extension.deliver(history(thread));
  }
  return { extension, client };
}

/** The outcome if the promise has settled by the time pending callbacks have run, else undefined. */
async function settled(outcome: Promise<PromptOutcome> | null): Promise<PromptOutcome | undefined> {
  let result: PromptOutcome | undefined;
  void outcome?.then((value) => (result = value));
  await Promise.resolve();
  return result;
}

describe('sidebarClient', () => {
  it('keeps the shown thread from what the extension sends, and tells subscribers when it changes', () => {
    const { extension, client } = connect(null);
    let changes = 0;
    const unsubscribe = client.subscribe(() => changes++);

    extension.deliver(history(THREAD));
    expect(client.getSnapshot().thread).toEqual(THREAD);
    expect(changes).toBe(1);

    // An event for another thread changes nothing, so the snapshot stays the same object.
    const before = client.getSnapshot();
    extension.deliver({ type: 'event', threadId: 'thread-2', event: turnStarted, at: 0 });
    expect(client.getSnapshot()).toBe(before);
    expect(changes).toBe(1);

    unsubscribe();
    extension.deliver({ type: 'mode', threadId: 'thread-1', mode: 'plan' });
    expect(client.getSnapshot().mode).toBe('plan');
    expect(changes).toBe(1);
  });

  it('ignores messages that do not match the protocol', () => {
    const { extension, client } = connect();
    const before = client.getSnapshot();

    extension.deliverRaw({ data: { type: 'event', threadId: 'thread-1', event: { type: 'nonsense' }, at: 0 } });
    extension.deliverRaw({ data: 'history' });
    extension.deliverRaw({ data: undefined });

    expect(client.getSnapshot()).toBe(before);
  });

  it('numbers each prompt, and resolves with the answer to that prompt only', async () => {
    const { extension, client } = connect();

    const outcome = client.prompt('Hello');
    expect(extension.sent).toEqual([{ type: 'prompt', threadId: 'thread-1', submissionId: 'submission-1', text: 'Hello' }]);
    expect(client.getSnapshot().running).toBe(true);

    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-0', status: 'accepted' });
    expect(await settled(outcome)).toBeUndefined();

    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-1', status: 'accepted' });
    expect(await settled(outcome)).toEqual({ status: 'accepted' });
    // An accepted prompt stays running until its turn ends.
    expect(client.getSnapshot().running).toBe(true);
  });

  it('stops the shown thread running when its prompt is rejected', async () => {
    const { extension, client } = connect();

    const outcome = client.prompt('Hello');
    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-1', status: 'rejected', reason: 'busy' });

    expect(await settled(outcome)).toEqual({ status: 'rejected', reason: 'busy' });
    expect(client.getSnapshot().running).toBe(false);
  });

  it('answers a prompt to a thread no longer shown without touching the shown one', async () => {
    const { extension, client } = connect();
    const first = client.prompt('To the first thread');
    extension.deliver(history(OTHER));
    const second = client.prompt('To the second thread');

    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-1', status: 'rejected', reason: 'stale' });

    expect(await settled(first)).toEqual({ status: 'rejected', reason: 'stale' });
    expect(client.getSnapshot().running).toBe(true);
    expect(await settled(second)).toBeUndefined();
  });

  it('counts only the latest prompt to a thread', async () => {
    const { extension, client } = connect();
    const first = client.prompt('First');
    // Showing the thread again replaces its state, so it can take another prompt.
    extension.deliver(history(THREAD));
    const second = client.prompt('Second');

    expect(await settled(first)).toEqual({ status: 'superseded' });
    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-1', status: 'accepted' });
    expect(await settled(second)).toBeUndefined();
    extension.deliver({ type: 'prompt_result', threadId: 'thread-1', submissionId: 'submission-2', status: 'accepted' });
    expect(await settled(second)).toEqual({ status: 'accepted' });
  });

  it('sends no prompt without a thread, while one runs, to a read-only thread, or with blank text', () => {
    const { extension, client } = connect(null);
    expect(client.prompt('Hello')).toBeNull();

    extension.deliver(history(THREAD));
    expect(client.prompt('  \n')).toBeNull();

    extension.deliver({ type: 'event', threadId: 'thread-1', event: turnStarted, at: 0 });
    expect(client.prompt('Hello')).toBeNull();

    extension.deliver(history(THREAD, [], 'Session can’t be resumed — start a new thread.'));
    expect(client.prompt('Hello')).toBeNull();

    expect(extension.sent).toEqual([]);
  });

  it('sends the user’s actions for the shown thread, and only those it can take', () => {
    const { extension, client } = connect(null);
    client.respond('permission-1', 'allow');
    client.setMode('plan');
    client.setAgent('codex');
    client.setModel('opus');
    client.requestModels();
    expect(extension.sent).toEqual([]);

    client.ready();
    client.copy('1 2 3');
    extension.deliver(history(THREAD));
    client.respond('permission-1', 'allow');
    client.setMode('plan');
    client.setAgent('codex');
    client.setModel('opus');
    client.requestModels();
    expect(extension.sent).toEqual([
      { type: 'ready' },
      { type: 'copy', text: '1 2 3' },
      { type: 'permission_response', threadId: 'thread-1', requestId: 'permission-1', optionId: 'allow' },
      { type: 'set_mode', threadId: 'thread-1', mode: 'plan' },
      { type: 'set_agent', threadId: 'thread-1', agent: 'codex' },
      { type: 'set_model', threadId: 'thread-1', agent: 'claude', model: 'opus' },
      { type: 'get_models', threadId: 'thread-1', agent: 'claude' },
    ]);

    // Once a turn has started the agent is locked, and while it runs the model is too.
    const before = extension.sent.length;
    extension.deliver({ type: 'event', threadId: 'thread-1', event: turnStarted, at: 0 });
    client.setAgent('codex');
    client.setModel('opus');
    expect(extension.sent).toHaveLength(before);
  });

  it('stops listening once closed', () => {
    const { extension, client } = connect(null);
    client.close();

    extension.deliver(history(THREAD));

    expect(client.getSnapshot().thread).toBeUndefined();
  });
});
