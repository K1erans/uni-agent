import { DEFAULT_MODE, type Mode, type ModelInfo } from '../../src/agents/events';
import type { ExtensionMessage, ThreadInfo } from '../../src/protocol';
import { applyEvent, awaitingApproval, emptyTranscript, type Transcript } from '../../src/transcript';

export type { Approval, ErrorItem, SessionConfig, TextItem, ToolCallItem, TranscriptItem, TurnItem } from '../../src/transcript';
export { applyEvent, awaitingApproval, waitingToolCalls } from '../../src/transcript';

/**
 * What the sidebar shows: the thread's transcript, and the settings and state around it. While a
 * prompt is on its way to start a turn, `running` is already set, so the composer cannot send.
 */
export interface ThreadState extends Transcript {
  /** The thread shown, including the agent it talks to; undefined until the extension sends one. */
  thread: ThreadInfo | undefined;
  /** How freely the thread's agent may act, as the extension last reported it. */
  mode: Mode;
  selectedModel: string | null;
  models: ReadonlyArray<ModelInfo> | undefined;
  modelError: string | null;
  /** The branch checked out in the thread's workspace, if known. */
  branch: string | null;
  /** Why the thread takes no more prompts, if it does not. */
  readOnly: string | null;
}

export const emptyThread: ThreadState = {
  ...emptyTranscript,
  thread: undefined,
  mode: DEFAULT_MODE,
  selectedModel: null,
  models: undefined,
  modelError: null,
  branch: null,
  readOnly: null,
};

/**
 * What changes the thread: a message from the extension, or the composer having posted a prompt.
 * The webview blocks a second send while it waits for the extension's admission result.
 */
export type ThreadAction = ExtensionMessage | { type: 'prompt_sent' } | { type: 'prompt_rejected' };

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'history':
      return action.events.reduce(applyEvent, { ...emptyThread, thread: action.thread, mode: action.mode, selectedModel: action.model, readOnly: action.readOnly });
    case 'event':
      // Events only come from the shown thread; this guards against one crossing a thread switch.
      return action.threadId === state.thread?.id ? applyEvent(state, action) : state;
    case 'mode':
      return action.threadId === state.thread?.id ? { ...state, mode: action.mode } : state;
    case 'model':
      return action.threadId === state.thread?.id ? { ...state, selectedModel: action.model } : state;
    case 'read_only':
      return action.threadId === state.thread?.id ? { ...state, readOnly: action.reason } : state;
    case 'models':
      return action.threadId === state.thread?.id && action.agent === state.thread.agent
        ? { ...state, models: action.models, modelError: action.error?.message ?? null }
        : state;
    case 'branch':
      return { ...state, branch: action.name };
    case 'prompt_sent':
      return { ...state, running: true };
    case 'prompt_rejected':
      return { ...state, running: false };
    case 'prompt_result':
      return state;
  }
}

/** How the thread's agent is doing, for the status dot in the heading. */
export type AgentStatus = 'ready' | 'working' | 'needs_approval' | 'not_found' | 'not_signed_in' | 'stopped' | 'read_only';

export function agentStatus(state: ThreadState): AgentStatus {
  if (awaitingApproval(state)) {
    return 'needs_approval';
  }
  if (state.running) {
    return 'working';
  }
  if (state.readOnly !== null) {
    return 'read_only';
  }
  switch (state.lastError) {
    case 'binary_missing':
      return 'not_found';
    case 'not_signed_in':
      return 'not_signed_in';
    case 'process_crashed':
    case 'resume_failed':
      return 'stopped';
    // An error of the agent's own (an API error, a rate limit) leaves it able to take the next prompt.
    case 'agent_error':
    case undefined:
      return 'ready';
  }
}
