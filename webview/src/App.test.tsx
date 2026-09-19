import type { VscodeButton, VscodeTextarea } from '@vscode-elements/elements';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/agents/events';
import type { ExtensionMessage } from '../../src/protocol';
import { App } from './App';
import type { TranscriptItem } from './threadState';
import { Transcript } from './Transcript';

function receive(message: ExtensionMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const chunk = (text: string): AgentEvent => ({
  type: 'session_update',
  turnId: 't1',
  update: { sessionUpdate: 'agent_message_chunk', messageId: 'm:0', content: { type: 'text', text } },
});

const sendButton = () => document.querySelector<VscodeButton>('vscode-button')!;

function type(text: string) {
  const textarea = document.querySelector<VscodeTextarea>('vscode-textarea')!;
  textarea.value = text;
  fireEvent.input(textarea);
}

describe('App', () => {
  it('renders an empty thread with a composer', () => {
    render(<App post={() => {}} />);

    expect(screen.getByText('No messages yet.')).toBeTruthy();
    expect(document.querySelector('vscode-textarea')).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it('posts the draft as a prompt and clears it', () => {
    const post = vi.fn();
    render(<App post={post} />);

    type('Hello');
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());

    expect(post).toHaveBeenCalledWith({ type: 'prompt', text: 'Hello' });
    expect(document.querySelector<VscodeTextarea>('vscode-textarea')!.value).toBe('');
  });

  it('blocks sending from the moment a prompt is posted, before the turn starts', () => {
    const post = vi.fn();
    render(<App post={post} />);

    type('First');
    fireEvent.click(sendButton());
    type('Second');

    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(post).toHaveBeenCalledTimes(1);
    expect(document.querySelector<VscodeTextarea>('vscode-textarea')!.value).toBe('Second');

    receive({ type: 'event', event: { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'First' }] } });
    receive({ type: 'event', event: { type: 'turn_ended', turnId: 't1', stopReason: 'end_turn' } });
    expect(sendButton().disabled).toBe(false);
  });

  it('streams the reply in and blocks sending until the turn ends', () => {
    render(<App post={() => {}} />);

    receive({ type: 'event', event: { type: 'turn_started', turnId: 't1', prompt: [{ type: 'text', text: 'Count' }] } });
    type('Another');
    expect(sendButton().disabled).toBe(true);

    receive({ type: 'event', event: chunk('1') });
    receive({ type: 'event', event: chunk('\n2') });
    expect(screen.getByText(/1\s+2/)).toBeTruthy();

    receive({ type: 'event', event: { type: 'turn_ended', turnId: 't1', stopReason: 'end_turn' } });
    expect(sendButton().disabled).toBe(false);
  });

  it('ignores messages that do not match the protocol', () => {
    render(<App post={() => {}} />);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'event', event: { type: 'nonsense' } } }));
    });

    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });

  it('shows agent errors in the thread', () => {
    render(<App post={() => {}} />);

    receive({
      type: 'history',
      events: [{ type: 'error', code: 'binary_missing', message: 'Claude Code ("claude") was not found on PATH.' }],
    });

    expect(screen.getByRole('alert').textContent).toContain('was not found on PATH');
  });
});

describe('Transcript', () => {
  it('re-renders only the item that is streaming', () => {
    let finishedRenders = 0;
    // A getter counts how often the finished item's component reads it, i.e. renders.
    const finished: TranscriptItem = {
      kind: 'agent_message',
      id: 'm:0',
      get text() {
        finishedRenders++;
        return 'Finished message';
      },
    };
    const streaming = (text: string): TranscriptItem => ({ kind: 'agent_message', id: 'm:1', text });

    const { rerender } = render(<Transcript items={[finished, streaming('Str')]} running />);
    const rendersAfterMount = finishedRenders;
    rerender(<Transcript items={[finished, streaming('Streaming')]} running />);

    expect(screen.getByText('Streaming')).toBeTruthy();
    expect(finishedRenders).toBe(rendersAfterMount);
  });
});
