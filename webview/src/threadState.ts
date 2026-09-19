import type { AgentErrorCode, StopReason } from '../../src/agents/events';
import type { ExtensionMessage, ThreadEvent, ThreadInfo } from '../../src/protocol';

export interface ErrorItem {
  kind: 'error';
  id: string;
  code: AgentErrorCode;
  message: string;
}

/** A streamed piece of the agent's reply or thinking, grouped by the agent's message ID. */
export interface TextItem {
  id: string;
  text: string;
}

/** One prompt and everything the agent sent back for it. */
export interface TurnItem {
  kind: 'turn';
  id: string;
  prompt: string;
  /** When the turn started and ended, in milliseconds since the epoch. */
  startedAt: number;
  endedAt: number | undefined;
  /** Why the turn ended; undefined while it runs. */
  stopReason: StopReason | undefined;
  thoughts: TextItem[];
  messages: TextItem[];
  errors: ErrorItem[];
}

/** Turns, and errors that happened outside a turn (such as the agent's CLI missing at startup). */
export type TranscriptItem = TurnItem | ErrorItem;

export interface SessionConfig {
  model: string;
  permissionMode: string;
}

export interface ThreadState {
  /** The thread shown, including the agent it talks to; undefined until the extension sends one. */
  thread: ThreadInfo | undefined;
  /** What the agent last reported running the session with; undefined until its process starts. */
  config: SessionConfig | undefined;
  /** The branch checked out in the thread's workspace, if known. */
  branch: string | null;
  items: TranscriptItem[];
  /** A turn is in progress or a prompt is on its way to start one, so the composer cannot send. */
  running: boolean;
  /** The code of the latest error since the last turn started. */
  lastError: AgentErrorCode | undefined;
}

export const emptyThread: ThreadState = {
  thread: undefined,
  config: undefined,
  branch: null,
  items: [],
  running: false,
  lastError: undefined,
};

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
      return action.events.reduce(applyEvent, { ...emptyThread, thread: action.thread });
    case 'event':
      // Events only come from the shown thread; this guards against one crossing a thread switch.
      return action.threadId === state.thread?.id ? applyEvent(state, action) : state;
    case 'branch':
      return { ...state, branch: action.name };
    case 'prompt_sent':
      return { ...state, running: true };
  }
}

/**
 * Folds one agent event into the thread. Items that do not change keep their identity, so
 * memoised components re-render only for the turn, and the text, that is streaming.
 */
export function applyEvent(state: ThreadState, { event, at }: ThreadEvent): ThreadState {
  switch (event.type) {
    case 'session_configured':
      return { ...state, config: { model: event.model, permissionMode: event.permissionMode } };
    case 'turn_started': {
      const turn: TurnItem = {
        kind: 'turn',
        id: event.turnId,
        prompt: event.prompt.map((block) => block.text).join('\n'),
        startedAt: at,
        endedAt: undefined,
        stopReason: undefined,
        thoughts: [],
        messages: [],
        errors: [],
      };
      return { ...state, items: [...state.items, turn], running: true, lastError: undefined };
    }
    case 'turn_ended':
      return {
        ...state,
        items: updateTurn(state.items, event.turnId, (turn) => ({ ...turn, endedAt: at, stopReason: event.stopReason })),
        running: false,
      };
    case 'error': {
      const { turnId, code, message } = event;
      const turnIndex = turnId === undefined ? -1 : findTurn(state.items, turnId);
      if (turnIndex === -1) {
        return { ...state, items: [...state.items, { kind: 'error', id: `error:${state.items.length}`, code, message }], lastError: code };
      }
      return {
        ...state,
        items: replaceAt(state.items, turnIndex, (turn) => ({
          ...turn,
          errors: [...turn.errors, { kind: 'error', id: `${turn.id}:error:${turn.errors.length}`, code, message }],
        })),
        lastError: code,
      };
    }
    case 'session_update': {
      const { update } = event;
      if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') {
        return state;
      }
      const field = update.sessionUpdate === 'agent_message_chunk' ? 'messages' : 'thoughts';
      return {
        ...state,
        items: updateTurn(state.items, event.turnId, (turn) => ({
          ...turn,
          [field]: appendText(turn[field], update.messageId, update.content.text),
        })),
      };
    }
    default:
      return state;
  }
}

/** The index of the turn with this ID, searching from the end where the running turn is. */
function findTurn(items: TranscriptItem[], turnId: string): number {
  return items.findLastIndex((item) => item.kind === 'turn' && item.id === turnId);
}

function replaceAt(items: TranscriptItem[], index: number, update: (turn: TurnItem) => TurnItem): TranscriptItem[] {
  const item = items[index];
  if (item.kind !== 'turn') {
    return items;
  }
  const next = items.slice();
  next[index] = update(item);
  return next;
}

function updateTurn(items: TranscriptItem[], turnId: string, update: (turn: TurnItem) => TurnItem): TranscriptItem[] {
  const index = findTurn(items, turnId);
  return index === -1 ? items : replaceAt(items, index, update);
}

function appendText(items: TextItem[], id: string, text: string): TextItem[] {
  // The streaming item is almost always the last one, so search from the end.
  const index = items.findLastIndex((item) => item.id === id);
  if (index === -1) {
    return [...items, { id, text }];
  }
  const next = items.slice();
  next[index] = { id, text: items[index].text + text };
  return next;
}

/** How the thread's agent is doing, for the status dot in the heading. */
export type AgentStatus = 'ready' | 'working' | 'not_found' | 'not_signed_in' | 'stopped';

export function agentStatus(state: ThreadState): AgentStatus {
  if (state.running) {
    return 'working';
  }
  switch (state.lastError) {
    case 'binary_missing':
      return 'not_found';
    case 'not_signed_in':
      return 'not_signed_in';
    case 'process_crashed':
      return 'stopped';
    // An error of the agent's own (an API error, a rate limit) leaves it able to take the next prompt.
    case 'agent_error':
    case undefined:
      return 'ready';
  }
}
