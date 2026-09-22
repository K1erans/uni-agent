import { Option, Schema } from 'effect';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Mode } from '../../src/agents/events';
import { ExtensionMessage, type WebviewMessage } from '../../src/protocol';
import { Composer } from './Composer';
import { AGENT_NAMES } from './labels';
import { ThreadHeading } from './ThreadHeading';
import { emptyThread, threadReducer } from './threadState';
import { Transcript } from './Transcript';

const decodeExtensionMessage = Schema.decodeUnknownOption(ExtensionMessage);

/** Unsent drafts by thread ID. */
export type Drafts = ReadonlyMap<string, string>;

/** Keeps unsent drafts while VS Code disposes the webview, which it does whenever the sidebar is hidden. */
export interface DraftStore {
  load(): Drafts;
  save(drafts: Drafts): void;
}

interface AppProps {
  post: (message: WebviewMessage) => void;
  drafts?: DraftStore;
}

export function App({ post, drafts }: AppProps) {
  const [state, dispatch] = useReducer(threadReducer, emptyThread);
  // Each thread keeps its own draft, so switching thread never sends one thread's draft to another.
  const [draftsByThread, setDraftsByThread] = useState<Drafts>(() => drafts?.load() ?? new Map());
  const [rejections, setRejections] = useState<ReadonlyMap<string, string>>(new Map());
  const pending = useRef(new Map<string, { submissionId: string; text: string }>());
  const nextSubmission = useRef(0);
  const threadId = state.thread?.id;
  const draft = threadId === undefined ? '' : (draftsByThread.get(threadId) ?? '');
  const setDraft = (text: string) => {
    if (threadId !== undefined) {
      setDraftsByThread((previous) => withDraft(previous, threadId, text));
      setRejections((previous) => withoutReason(previous, threadId));
    }
  };
  // Read by the stable callbacks below, so memoised turns do not re-render when these change.
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => Option.map(decodeExtensionMessage(event.data), (message) => {
      if (message.type === 'prompt_result') {
        const submitted = pending.current.get(message.threadId);
        if (!submitted || submitted.submissionId !== message.submissionId) {
          return;
        }
        pending.current.delete(message.threadId);
        if (message.status === 'accepted') {
          setDraftsByThread((previous) => previous.get(message.threadId) === submitted.text ? withDraft(previous, message.threadId, '') : previous);
        } else {
          setRejections((previous) => new Map(previous).set(message.threadId, rejectionReason(message.reason)));
          if (latest.current.thread?.id === message.threadId) {
            latest.current = threadReducer(latest.current, { type: 'prompt_rejected' });
            dispatch({ type: 'prompt_rejected' });
          }
        }
        return;
      }
      dispatch(message);
    });
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Braces matter: whatever `save` returns must not reach React, which would call it as a cleanup.
  useEffect(() => {
    drafts?.save(draftsByThread);
  }, [drafts, draftsByThread]);

  /** Posts a prompt to the shown thread, unless a turn is running or no thread is shown yet. */
  const sendPrompt = useCallback(
    (text: string) => {
      const { thread, running } = latest.current;
      if (!thread || running || !text.trim()) {
        return;
      }
      const submissionId = `submission-${++nextSubmission.current}`;
      pending.current.set(thread.id, { submissionId, text });
      setRejections((previous) => withoutReason(previous, thread.id));
      post({ type: 'prompt', threadId: thread.id, submissionId, text });
      // Also update the ref now, so a second send before React re-renders is refused too.
      latest.current = threadReducer(latest.current, { type: 'prompt_sent' });
      dispatch({ type: 'prompt_sent' });
    },
    [post]
  );
  const copy = useCallback((text: string) => post({ type: 'copy', text }), [post]);
  const respond = useCallback(
    (requestId: string, optionId: string) => {
      const { thread } = latest.current;
      if (thread) {
        post({ type: 'permission_response', threadId: thread.id, requestId, optionId });
      }
    },
    [post]
  );

  const setMode = useCallback(
    (mode: Mode) => {
      const { thread } = latest.current;
      if (thread) {
        post({ type: 'set_mode', threadId: thread.id, mode });
      }
    },
    [post]
  );

  const agentName = state.thread ? AGENT_NAMES[state.thread.agent] : 'the agent';
  return (
    <main className="sidebar">
      <ThreadHeading state={state} />
      <Transcript items={state.items} running={state.running} onRetry={sendPrompt} onCopy={copy} onRespond={respond} />
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => {
          sendPrompt(draft);
        }}
        rejection={threadId === undefined ? undefined : rejections.get(threadId)}
        canSend={state.thread !== undefined && !state.running && draft.trim() !== ''}
        agentName={agentName}
        mode={state.mode}
        onModeChange={state.thread ? setMode : undefined}
        config={state.config}
        workspace={state.thread?.workspace ?? null}
        branch={state.branch}
      />
    </main>
  );
}

function rejectionReason(reason: 'busy' | 'stale' | 'empty' | 'unknown'): string {
  switch (reason) {
    case 'busy': return 'This thread is busy. Your message is still here.';
    case 'stale': return 'The shown thread changed. Your message is still here.';
    case 'empty': return 'Enter a message before sending.';
    case 'unknown': return 'This thread is no longer available. Your message is still here.';
  }
}

function withoutReason(reasons: ReadonlyMap<string, string>, threadId: string): ReadonlyMap<string, string> {
  if (!reasons.has(threadId)) {
    return reasons;
  }
  const next = new Map(reasons);
  next.delete(threadId);
  return next;
}

function withDraft(drafts: Drafts, threadId: string, text: string): Drafts {
  const next = new Map(drafts);
  if (text) {
    next.set(threadId, text);
  } else {
    next.delete(threadId);
  }
  return next;
}
