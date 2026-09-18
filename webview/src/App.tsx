import { VscodeButton, VscodeTextarea } from '@vscode-elements/react-elements';

export function App() {
  return (
    <main className="thread">
      <section className="transcript" aria-label="Conversation">
        <p className="empty-state">No messages yet.</p>
      </section>
      <form className="composer" onSubmit={(event) => event.preventDefault()}>
        <VscodeTextarea className="composer-input" label="Message" placeholder="Message the agent…" rows={3} />
        <div className="composer-actions">
          <VscodeButton disabled title="No agent is connected yet">
            Send
          </VscodeButton>
        </div>
      </form>
    </main>
  );
}
