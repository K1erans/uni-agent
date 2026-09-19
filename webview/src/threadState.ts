import type { AgentErrorCode, AgentEvent } from '../../src/agents/events';
import type { ExtensionMessage } from '../../src/protocol';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent_message'; id: string; text: string }
  | { kind: 'agent_thought'; id: string; text: string }
  | { kind: 'error'; id: string; code: AgentErrorCode; message: string };

export interface ThreadState {
  items: TranscriptItem[];
  /** A turn is in progress or a prompt is on its way to start one, so the composer cannot send. */
  running: boolean;
}

export const emptyThread: ThreadState = { items: [], running: false };

/**
 * What changes the thread: a message from the extension, or the composer having posted a prompt.
 * The extension ignores prompts while a turn runs, and it counts the turn as running from the moment
 * it accepts the prompt, before `turn_started` arrives. So the webview stops sending from the moment
 * it posts; `turn_started` and then `turn_ended` always follow an accepted prompt.
 */
export type ThreadAction = ExtensionMessage | { type: 'prompt_sent' };

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'history':
      return action.events.reduce(applyEvent, emptyThread);
    case 'event':
      return applyEvent(state, action.event);
    case 'prompt_sent':
      return { ...state, running: true };
  }
}

/**
 * Folds one agent event into the transcript. Items that do not change keep their identity, so
 * memoised item components re-render only for the item that is streaming.
 */
export function applyEvent(state: ThreadState, event: AgentEvent): ThreadState {
  switch (event.type) {
    case 'turn_started': {
      const text = event.prompt.map((block) => block.text).join('\n');
      return { items: [...state.items, { kind: 'user', id: `${event.turnId}:prompt`, text }], running: true };
    }
    case 'turn_ended':
      return { ...state, running: false };
    case 'error':
      return {
        ...state,
        items: [...state.items, { kind: 'error', id: `error:${state.items.length}`, code: event.code, message: event.message }],
      };
    case 'session_update': {
      const { update } = event;
      if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent_message' : 'agent_thought';
        return { ...state, items: appendText(state.items, kind, update.messageId, update.content.text) };
      }
      return state;
    }
    default:
      return state;
  }
}

function appendText(
  items: TranscriptItem[],
  kind: 'agent_message' | 'agent_thought',
  id: string,
  text: string
): TranscriptItem[] {
  // The streaming item is almost always the last one, so search from the end.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.id === id && item.kind === kind) {
      const next = items.slice();
      next[i] = { ...item, text: item.text + text };
      return next;
    }
  }
  return [...items, { kind, id, text }];
}
