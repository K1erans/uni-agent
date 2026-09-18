import { describe, expect, it, vi } from 'vitest';
import { AgentEventEmitter, type AgentAdapter } from './agents/adapter';
import type { AgentEvent, ContentBlock, StopReason } from './agents/events';
import { Thread } from './thread';

class FakeAdapter extends AgentEventEmitter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly sessionId = 'session-1';
  readonly prompts: ContentBlock[][] = [];
  disposed = false;

  start(): void {
    this.emit({ type: 'session_started', agent: 'claude', sessionId: this.sessionId });
  }

  prompt(prompt: ContentBlock[]): Promise<StopReason> {
    this.prompts.push(prompt);
    this.emit({ type: 'turn_started', turnId: `turn-${this.prompts.length}`, prompt });
    return new Promise(() => {});
  }

  endTurn(): void {
    this.emit({ type: 'turn_ended', turnId: `turn-${this.prompts.length}`, stopReason: 'end_turn' });
  }

  async cancel(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
  }
}

describe('Thread', () => {
  it('replays its history to every webview that attaches, then forwards new events', () => {
    const adapter = new FakeAdapter();
    const thread = new Thread(adapter);
    const first = vi.fn();
    thread.attach(first);
    thread.handle({ type: 'prompt', text: 'hi' });

    // A reloaded webview gets everything so far in one message.
    const second = vi.fn();
    thread.attach(second);
    const history = second.mock.calls[0][0] as { events: AgentEvent[] };
    expect(history.events.map((event) => event.type)).toEqual(['session_started', 'turn_started']);

    adapter.endTurn();
    expect(second).toHaveBeenLastCalledWith({ type: 'event', event: expect.objectContaining({ type: 'turn_ended' }) });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('ignores prompts while a turn is running and blank prompts', () => {
    const adapter = new FakeAdapter();
    const thread = new Thread(adapter);

    thread.handle({ type: 'prompt', text: '   ' });
    thread.handle({ type: 'prompt', text: 'one' });
    thread.handle({ type: 'prompt', text: 'two' });
    adapter.endTurn();
    thread.handle({ type: 'prompt', text: 'three' });

    expect(adapter.prompts.map(([block]) => block.text)).toEqual(['one', 'three']);
  });

  it('disposes the adapter with the thread', () => {
    const adapter = new FakeAdapter();
    new Thread(adapter).dispose();
    expect(adapter.disposed).toBe(true);
  });
});
