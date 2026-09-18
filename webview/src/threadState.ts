import type { AgentErrorCode, AgentEvent } from '../../src/agents/events';
import type { ExtensionMessage } from '../../src/protocol';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent_message'; id: string; text: string }
  | { kind: 'agent_thought'; id: string; text: string }
  | { kind: 'error'; id: string; code: AgentErrorCode; message: string };

export interface ThreadState {
  items: TranscriptItem[];
  /** A turn is in progress, so the composer cannot send. */
  running: boolean;
}

export const emptyThread: ThreadState = { items: [], running: false };

export function threadReducer(state: ThreadState, message: ExtensionMessage): ThreadState {
  return message.type === 'history' ? message.events.reduce(applyEvent, emptyThread) : applyEvent(state, message.event);
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
