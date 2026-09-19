import { Option, Schema } from 'effect';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ExtensionMessage, type WebviewMessage } from '../../src/protocol';
import { Composer } from './Composer';
import { AGENT_NAMES } from './labels';
import { ThreadHeading } from './ThreadHeading';
import { emptyThread, threadReducer } from './threadState';
import { Transcript } from './Transcript';

const decodeExtensionMessage = Schema.decodeUnknownOption(ExtensionMessage);

/** Keeps the unsent draft while VS Code disposes the webview, which it does whenever the sidebar is hidden. */
export interface DraftStore {
  load(): string;
  save(draft: string): void;
}

interface AppProps {
  post: (message: WebviewMessage) => void;
  drafts?: DraftStore;
}

export function App({ post, drafts }: AppProps) {
  const [state, dispatch] = useReducer(threadReducer, emptyThread);
  const [draft, setDraft] = useState(() => drafts?.load() ?? '');
  // Read by the stable callbacks below, so memoised turns do not re-render when these change.
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => Option.map(decodeExtensionMessage(event.data), dispatch);
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => drafts?.save(draft), [drafts, draft]);

  /** Posts a prompt to the shown thread, unless a turn is running or no thread is shown yet. */
  const sendPrompt = useCallback(
    (text: string) => {
      const { thread, running } = latest.current;
      if (!thread || running || !text.trim()) {
        return;
      }
      post({ type: 'prompt', threadId: thread.id, text });
      // Also update the ref now, so a second send before React re-renders is refused too.
      latest.current = threadReducer(latest.current, { type: 'prompt_sent' });
      dispatch({ type: 'prompt_sent' });
    },
    [post]
  );
  const copy = useCallback((text: string) => post({ type: 'copy', text }), [post]);

  const agentName = state.agent ? AGENT_NAMES[state.agent] : 'the agent';
  return (
    <main className="sidebar">
      <ThreadHeading state={state} />
      <Transcript items={state.items} running={state.running} onRetry={sendPrompt} onCopy={copy} />
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => {
          sendPrompt(draft);
          setDraft('');
        }}
        canSend={state.thread !== undefined && !state.running && draft.trim() !== ''}
        agentName={agentName}
        config={state.config}
        workspace={state.thread?.workspace ?? null}
        branch={state.branch}
      />
    </main>
  );
}
