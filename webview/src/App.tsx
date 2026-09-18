import type { VscodeTextarea as VscodeTextareaElement } from '@vscode-elements/elements';
import { VscodeButton, VscodeTextarea } from '@vscode-elements/react-elements';
import { useEffect, useReducer, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ExtensionMessage, WebviewMessage } from '../../src/protocol';
import { emptyThread, threadReducer } from './threadState';
import { Transcript } from './Transcript';

export function App({ post }: { post: (message: WebviewMessage) => void }) {
  const [thread, dispatch] = useReducer(threadReducer, emptyThread);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionMessage>) => dispatch(event.data);
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const canSend = !thread.running && draft.trim() !== '';
  const send = () => {
    if (canSend) {
      post({ type: 'prompt', text: draft });
      setDraft('');
    }
  };

  return (
    <main className="thread">
      <Transcript items={thread.items} running={thread.running} />
      <form
        className="composer"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          send();
        }}
      >
        <VscodeTextarea
          className="composer-input"
          label="Message"
          placeholder="Message Claude Code…"
          rows={3}
          value={draft}
          onInput={(event) => setDraft((event.target as VscodeTextareaElement).value)}
          onKeyDown={(event: KeyboardEvent) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <VscodeButton disabled={!canSend} onClick={send}>
            Send
          </VscodeButton>
        </div>
      </form>
    </main>
  );
}
