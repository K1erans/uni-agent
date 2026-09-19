import { VscodeTextarea as VscodeTextareaElement } from '@vscode-elements/elements/dist/vscode-textarea/vscode-textarea.js';
import { VscodeButton, VscodeTextarea } from '@vscode-elements/react-elements';
import { Option, Schema } from 'effect';
import { useEffect, useReducer, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExtensionMessage, type WebviewMessage } from '../../src/protocol';
import { emptyThread, threadReducer } from './threadState';
import { Transcript } from './Transcript';

const decodeExtensionMessage = Schema.decodeUnknownOption(ExtensionMessage);

export function App({ post }: { post: (message: WebviewMessage) => void }) {
  const [thread, dispatch] = useReducer(threadReducer, emptyThread);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const onMessage = (event: MessageEvent) => Option.map(decodeExtensionMessage(event.data), dispatch);
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const canSend = !thread.running && draft.trim() !== '';
  const send = () => {
    if (canSend) {
      post({ type: 'prompt', text: draft });
      dispatch({ type: 'prompt_sent' });
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
          onInput={(event) => {
            if (event.target instanceof VscodeTextareaElement) {
              setDraft(event.target.value);
            }
          }}
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
