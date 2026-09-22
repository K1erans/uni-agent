import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Mode } from '../../src/agents/events';
import type { ExtensionMessage, ThreadInfo } from '../../src/protocol';
import { App, type Drafts } from './App';
import type { TurnItem } from './threadState';
import { Transcript } from './Transcript';

function receive(message: ExtensionMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const THREAD: ThreadInfo = { id: 'thread-1', agent: 'claude', workspace: 'uni-agent' };

/** Shows a thread with these events, as the extension does when the webview reports ready. */
function open(events: AgentEvent[] = [{ type: 'session_started', agent: 'claude', sessionId: 's1' }], thread = THREAD, mode: Mode = 'auto_edit') {
  receive({ type: 'history', thread, mode, events: events.map((event) => ({ event, at: 0 })) });
}

function event(agentEvent: AgentEvent, at = 0) {
  receive({ type: 'event', threadId: THREAD.id, event: agentEvent, at });
}

const chunk = (text: string): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: 'agent_message_chunk', messageId: 'm:0', content: { type: 'text', text } },
});
const turnStarted = (text: string, turnId = 't1'): AgentEvent => ({ type: 'turn_started', turnId, prompt: [{ type: 'text', text }] });
const turnEnded = (turnId = 't1'): AgentEvent => ({ type: 'turn_ended', turnId, stopReason: 'end_turn' });

const input = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
const modeSelect = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Mode' });
const modePicker = () => modeSelect().parentElement!;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe('App', () => {
  it('shows a new thread’s heading and an empty conversation above the composer', () => {
    render(<App post={() => {}} />);
    open();

    expect(screen.getByRole('heading', { name: 'New thread' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Status: Ready' })).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('No messages yet.')).toBeTruthy();
    expect(input().placeholder).toBe('Message Claude Code…');
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText('Enter to send · Shift + Enter for a new line').id).toBe(input().getAttribute('aria-describedby'));
  });

  it('names the thread’s agent, whichever it is', () => {
    render(<App post={() => {}} />);
    open([], { id: 'thread-2', agent: 'codex', workspace: 'uni-agent' });

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(input().placeholder).toBe('Message Codex…');
  });

  it('cannot send before the extension has sent a thread', () => {
    const post = vi.fn();
    render(<App post={post} />);

    type('Hello');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(sendButton().disabled).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the draft to the shown thread and clears it', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();

    type('Hello');
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());

    expect(post).toHaveBeenCalledWith({ type: 'prompt', threadId: 'thread-1', text: 'Hello' });
    expect(input().value).toBe('');
  });

  it('sends on Enter, but not on Shift+Enter or while an IME composition is open', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();
    type('こんにちは');

    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(post).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(post).toHaveBeenCalledWith({ type: 'prompt', threadId: 'thread-1', text: 'こんにちは' });
  });

  it('blocks sending from the moment a prompt is posted, before the turn starts', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();

    type('First');
    fireEvent.click(sendButton());
    type('Second');

    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('Second');

    event(turnStarted('First'));
    event(turnEnded());
    expect(sendButton().disabled).toBe(false);
  });

  it('streams the reply in, titles the thread, and blocks sending until the turn ends', () => {
    render(<App post={() => {}} />);
    open();

    event(turnStarted('Count\nto two'), 1_000);
    expect(screen.getByRole('heading', { name: 'Count' })).toBeTruthy();
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Status: Working' })).toBeTruthy();
    type('Another');
    expect(sendButton().disabled).toBe(true);

    event(chunk('1'));
    event(chunk('\n2'));
    expect(screen.getByText(/1\s+2/)).toBeTruthy();
    expect(screen.queryByText('Working…')).toBeNull();

    event(turnEnded(), 43_000);
    expect(sendButton().disabled).toBe(false);
    expect(screen.getByText('Worked for 42s')).toBeTruthy();
  });

  it('copies a reply and retries the latest prompt', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();
    event(turnStarted('Earlier', 't0'));
    event(turnEnded('t0'));
    event(turnStarted('Count'));
    event(chunk('1 2 3'));

    // Only the latest turn offers Retry, and not while it runs.
    expect(screen.queryByRole('button', { name: 'Retry prompt' })).toBeNull();
    event(turnEnded());
    expect(screen.getAllByRole('button', { name: 'Retry prompt' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Copy response' }));
    expect(post).toHaveBeenLastCalledWith({ type: 'copy', text: '1 2 3' });
    expect(screen.getByText('Copied')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry prompt' }));
    expect(post).toHaveBeenLastCalledWith({ type: 'prompt', threadId: 'thread-1', text: 'Count' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry prompt' }).disabled).toBe(true);
  });

  it('shows the session settings the agent reports; all but the mode are disabled until they can be changed', () => {
    render(<App post={() => {}} />);
    open();

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Model: Default model' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Workspace: uni-agent' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Branch/ })).toBeNull();

    event({ type: 'session_configured', model: 'claude-opus-5', permissionMode: 'acceptEdits' });
    receive({ type: 'branch', name: 'main' });

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Model: claude-opus-5' }).disabled).toBe(true);
    expect(modePicker().title).toContain('Claude Code runs it as Accept edits');
    expect(screen.getByRole('button', { name: 'Reasoning: Default' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Branch: main' })).toBeTruthy();
  });

  it('asks the extension to switch the shown thread’s mode, and shows the mode it reports', () => {
    const post = vi.fn();
    render(<App post={post} />);
    expect(modeSelect().disabled).toBe(true);
    open();
    expect(modeSelect().value).toBe('auto_edit');
    expect(modeSelect().disabled).toBe(false);

    fireEvent.change(modeSelect(), { target: { value: 'plan' } });
    expect(post).toHaveBeenLastCalledWith({ type: 'set_mode', threadId: 'thread-1', mode: 'plan' });
    // Until the extension confirms the switch, the picker keeps showing the mode the thread runs in.
    expect(modeSelect().value).toBe('auto_edit');

    receive({ type: 'mode', threadId: 'thread-1', mode: 'plan' });
    expect(modeSelect().value).toBe('plan');
    expect(modePicker().textContent).toContain('Plan');
  });

  it('can change the mode while a turn is running', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();
    event(turnStarted('Count'));

    fireEvent.change(modeSelect(), { target: { value: 'full_auto' } });
    expect(post).toHaveBeenLastCalledWith({ type: 'set_mode', threadId: 'thread-1', mode: 'full_auto' });
  });

  it('shows each thread’s own mode', () => {
    render(<App post={() => {}} />);
    open(undefined, THREAD, 'full_auto');
    expect(modeSelect().value).toBe('full_auto');

    open([], { id: 'thread-2', agent: 'codex', workspace: null }, 'plan');
    expect(modeSelect().value).toBe('plan');
  });

  it('replaces the conversation when the extension switches thread', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();
    event(turnStarted('First thread'));

    open([{ type: 'session_started', agent: 'claude', sessionId: 's2' }], { id: 'thread-2', agent: 'claude', workspace: null });
    expect(screen.queryByText('First thread')).toBeNull();
    expect(screen.getByRole('heading', { name: 'New thread' })).toBeTruthy();
    expect(screen.getByText('No folder open', { selector: '.meta-workspace' })).toBeTruthy();

    // The first thread's turn was still running, but the new thread can take a prompt.
    type('Second thread');
    fireEvent.click(sendButton());
    expect(post).toHaveBeenCalledWith({ type: 'prompt', threadId: 'thread-2', text: 'Second thread' });
  });

  it('keeps each thread’s unsent draft, including while the sidebar is hidden', () => {
    let saved: Drafts = new Map([['thread-1', 'Half-written']]);
    // `save` returns a value, as VS Code's `setState` does; the app must not hand it to React.
    const drafts = { load: () => saved, save: (next: Drafts) => (saved = next) };
    const post = vi.fn();
    const { unmount } = render(<App post={post} drafts={drafts} />);
    open();
    expect(input().value).toBe('Half-written');
    type('Half-written prompt');

    // Another thread starts with its own, empty draft; the first thread's is not sent there.
    open([], { id: 'thread-2', agent: 'claude', workspace: 'uni-agent' });
    expect(input().value).toBe('');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(post).not.toHaveBeenCalled();
    type('For the second thread');

    unmount();
    render(<App post={post} drafts={drafts} />);
    open();
    expect(input().value).toBe('Half-written prompt');
    open([], { id: 'thread-2', agent: 'claude', workspace: 'uni-agent' });
    expect(input().value).toBe('For the second thread');
  });

  it('ignores messages that do not match the protocol', () => {
    render(<App post={() => {}} />);
    open();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'event', threadId: 'thread-1', event: { type: 'nonsense' }, at: 0 } }));
    });

    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });

  it('shows agent errors in the thread and in the status', () => {
    render(<App post={() => {}} />);

    open([
      { type: 'session_started', agent: 'claude', sessionId: 's1' },
      { type: 'error', code: 'binary_missing', message: 'Claude Code ("claude") was not found on PATH.' },
    ]);

    expect(screen.getByRole('alert').textContent).toContain('was not found on PATH');
    expect(screen.getByRole('img', { name: 'Status: Not found' })).toBeTruthy();
  });
});

describe('App approvals', () => {
  const permissionRequest: AgentEvent = {
    type: 'permission_request',
    turnId: 't1',
    requestId: 'permission-1',
    toolCall: { toolCallId: 'call_1', title: 'rm notes.md', kind: 'delete', status: 'pending', rawInput: { command: 'rm notes.md' } },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  };

  it('shows the tool call, its input and the ask, and posts the answer the user picks', () => {
    const post = vi.fn();
    render(<App post={post} />);
    open();
    event(turnStarted('Tidy up'));
    event(permissionRequest);

    expect(screen.getByRole('img', { name: 'Status: Needs approval' })).toBeTruthy();
    expect(screen.getByText('rm notes.md')).toBeTruthy();
    expect(screen.getByText(/"command": "rm notes.md"/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(post).toHaveBeenCalledWith({ type: 'permission_response', threadId: 'thread-1', requestId: 'permission-1', optionId: 'allow' });
  });

  it('shows what a tool returned, whether as content or as the agent’s own value', () => {
    render(<App post={() => {}} />);
    open();
    event(turnStarted('Search'));
    event({
      type: 'session_update',
      turnId: 't1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'grep TODO', kind: 'search', status: 'in_progress', rawInput: { pattern: 'TODO' } },
    });
    event({
      type: 'session_update',
      turnId: 't1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'notes.md:3' } }],
        rawOutput: { totalMatches: 1 },
      },
    });

    expect(screen.getByText('notes.md:3')).toBeTruthy();
    expect(screen.getByText(/"totalMatches": 1/)).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('replaces the ask with the answer once the extension confirms it', () => {
    render(<App post={() => {}} />);
    open();
    event(turnStarted('Tidy up'));
    event(permissionRequest);
    event({ type: 'permission_resolved', turnId: 't1', requestId: 'permission-1', outcome: { outcome: 'selected', optionId: 'deny' } });

    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Deny');
    expect(screen.getByRole('img', { name: 'Status: Working' })).toBeTruthy();
  });
});

describe('Transcript', () => {
  it('re-renders only the text that is streaming', () => {
    let finishedRenders = 0;
    // A getter counts how often the finished message's component reads it, i.e. renders.
    const finished = {
      index: 0,
      id: 'm:0',
      get text() {
        finishedRenders++;
        return 'Finished message';
      },
    };
    const turn = (streaming: string): TurnItem => ({
      kind: 'turn',
      id: 't1',
      prompt: 'Go',
      startedAt: 0,
      endedAt: undefined,
      stopReason: undefined,
      thoughts: [],
      messages: [finished, { id: 'm:1', text: streaming, index: 1 }],
      tools: [],
      errors: [],
    });
    const noop = () => {};

    const { rerender } = render(<Transcript items={[turn('Str')]} running onRetry={noop} onCopy={noop} onRespond={noop} />);
    const rendersAfterMount = finishedRenders;
    rerender(<Transcript items={[turn('Streaming')]} running onRetry={noop} onCopy={noop} onRespond={noop} />);

    expect(screen.getByText('Streaming')).toBeTruthy();
    expect(finishedRenders).toBe(rendersAfterMount);
  });
});
