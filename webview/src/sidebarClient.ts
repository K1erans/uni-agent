import { Option, Schema } from 'effect';
import type { AgentKind, Mode } from '../../src/agents/events';
import { ExtensionMessage, type PromptRejection } from '../../src/protocol';
import { emptyThread, threadReducer, type ThreadAction, type ThreadState } from './threadState';
import type { Transport } from './transport';

const decodeExtensionMessage = Schema.decodeUnknownOption(ExtensionMessage);

/** How the extension answered a prompt. */
export type PromptOutcome =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: PromptRejection }
  // Another prompt went to the same thread before this one was answered; only the latest one's answer counts.
  | { status: 'superseded' };

/**
 * The sidebar's side of the protocol. It keeps the shown thread's state from what the extension
 * sends, ignoring anything that does not decode, and sends the user's actions for the shown thread.
 * Actions that the shown thread cannot take are not sent. The functions need no `this`, so they can
 * be passed around as they are.
 */
export interface SidebarClient {
  /** Calls `onChange` whenever the snapshot changes, until the returned function is called. */
  subscribe(onChange: () => void): () => void;
  /** The shown thread's state; the same object until something changes it. */
  getSnapshot(): ThreadState;
  /**
   * Sends a prompt to the shown thread, and resolves with the extension's answer. Returns null, and
   * sends nothing, when no thread is shown, a turn is running, the thread is read-only or the text
   * is blank. The thread counts as running from the moment the prompt is sent, and stops if it is
   * rejected while still shown.
   */
  prompt(text: string): Promise<PromptOutcome> | null;
  /** Answers an approval in the shown thread with the option the user chose. */
  respond(requestId: string, optionId: string): void;
  setMode(mode: Mode): void;
  /** Switches the shown thread's agent; only before its first turn. */
  setAgent(agent: AgentKind): void;
  /** Picks the shown thread's model, or its agent's default for null; not while a turn runs. */
  setModel(model: string | null): void;
  /** Asks for the models the shown thread's agent offers; they arrive in the snapshot. */
  requestModels(): void;
  copy(text: string): void;
  /** Tells the extension the webview is listening, so it sends the shown thread. */
  ready(): void;
  /** Stops listening to the extension. */
  close(): void;
}

export function createSidebarClient(transport: Transport): SidebarClient {
  let state = emptyThread;
  const listeners = new Set<() => void>();
  // The latest prompt sent to each thread, by thread ID, until the extension answers it.
  const pending = new Map<string, { submissionId: string; settle: (outcome: PromptOutcome) => void }>();
  let submissions = 0;

  const apply = (action: ThreadAction) => {
    const next = threadReducer(state, action);
    if (next !== state) {
      state = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const receive = (message: ExtensionMessage) => {
    if (message.type !== 'prompt_result') {
      apply(message);
      return;
    }
    const submitted = pending.get(message.threadId);
    if (!submitted || submitted.submissionId !== message.submissionId) {
      return;
    }
    pending.delete(message.threadId);
    if (message.status === 'accepted') {
      submitted.settle({ status: 'accepted' });
      return;
    }
    // A thread switched away from has been replaced by its successor's history, which is not running.
    if (state.thread?.id === message.threadId) {
      apply({ type: 'prompt_rejected' });
    }
    submitted.settle({ status: 'rejected', reason: message.reason });
  };

  const stopListening = transport.listen((delivery) => Option.map(decodeExtensionMessage(delivery.data), receive));

  return {
    subscribe: (onChange) => {
      // Wrapped, so each call subscribes once and unsubscribes once, even with the same function.
      const listener = () => onChange();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    prompt: (text) => {
      const { thread, running, readOnly } = state;
      if (!thread || running || readOnly !== null || !text.trim()) {
        return null;
      }
      const submissionId = `submission-${++submissions}`;
      pending.get(thread.id)?.settle({ status: 'superseded' });
      const outcome = new Promise<PromptOutcome>((settle) => {
        pending.set(thread.id, { submissionId, settle });
      });
      // Running before sending, so an answer delivered during `send` finds the prompt sent.
      apply({ type: 'prompt_sent' });
      transport.send({ type: 'prompt', threadId: thread.id, submissionId, text });
      return outcome;
    },
    respond: (requestId, optionId) => {
      if (state.thread) {
        transport.send({ type: 'permission_response', threadId: state.thread.id, requestId, optionId });
      }
    },
    setMode: (mode) => {
      if (state.thread) {
        transport.send({ type: 'set_mode', threadId: state.thread.id, mode });
      }
    },
    setAgent: (agent) => {
      if (state.thread && !state.items.some((item) => item.kind === 'turn')) {
        transport.send({ type: 'set_agent', threadId: state.thread.id, agent });
      }
    },
    setModel: (model) => {
      if (state.thread && !state.running) {
        transport.send({ type: 'set_model', threadId: state.thread.id, agent: state.thread.agent, model });
      }
    },
    requestModels: () => {
      if (state.thread) {
        transport.send({ type: 'get_models', threadId: state.thread.id, agent: state.thread.agent });
      }
    },
    copy: (text) => transport.send({ type: 'copy', text }),
    ready: () => transport.send({ type: 'ready' }),
    close: stopListening,
  };
}
