import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { PromptRejection } from '../../src/protocol';
import { Composer } from './Composer';
import { AGENT_NAMES } from './labels';
import type { SidebarClient } from './sidebarClient';
import { ThreadHeading } from './ThreadHeading';
import { Transcript } from './Transcript';

/** Unsent drafts by thread ID. */
export type Drafts = ReadonlyMap<string, string>;

/** Keeps unsent drafts while VS Code disposes the webview, which it does whenever the sidebar is hidden. */
export interface DraftStore {
  load(): Drafts;
  save(drafts: Drafts): void;
}

interface AppProps {
  client: SidebarClient;
  drafts?: DraftStore;
}

export function App({ client, drafts }: AppProps) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  // Each thread keeps its own draft, so switching thread never sends one thread's draft to another.
  const [draftsByThread, setDraftsByThread] = useState<Drafts>(() => drafts?.load() ?? new Map());
  const [rejections, setRejections] = useState<ReadonlyMap<string, string>>(new Map());
  const threadId = state.thread?.id;
  const draft = threadId === undefined ? '' : (draftsByThread.get(threadId) ?? '');
  const setDraft = (text: string) => {
    if (threadId !== undefined) {
      setDraftsByThread((previous) => withDraft(previous, threadId, text));
      setRejections((previous) => withoutReason(previous, threadId));
    }
  };

  // Braces matter: whatever `save` returns must not reach React, which would call it as a cleanup.
  useEffect(() => {
    drafts?.save(draftsByThread);
  }, [drafts, draftsByThread]);

  /**
   * Sends a prompt to the shown thread, if it can take one. The answer may arrive after a thread
   * switch, so it applies to the thread the prompt went to: an accepted prompt clears that thread's
   * draft, unless the user has changed it since, and a rejected one leaves the reason beside it.
   */
  const sendPrompt = useCallback(
    (text: string) => {
      // Read from the client rather than the render, which may be a message behind.
      const sentTo = client.getSnapshot().thread?.id;
      const outcome = client.prompt(text);
      if (sentTo === undefined || outcome === null) {
        return;
      }
      setRejections((previous) => withoutReason(previous, sentTo));
      void outcome.then((result) => {
        if (result.status === 'accepted') {
          setDraftsByThread((previous) => previous.get(sentTo) === text ? withDraft(previous, sentTo, '') : previous);
        } else if (result.status === 'rejected') {
          setRejections((previous) => new Map(previous).set(sentTo, rejectionReason(result.reason)));
        }
      });
    },
    [client]
  );

  useEffect(() => {
    client.requestModels();
  }, [client, state.thread?.id, state.thread?.agent]);

  const agentName = state.thread ? AGENT_NAMES[state.thread.agent] : 'the agent';
  return (
    <main className="sidebar">
      <ThreadHeading state={state} />
      <Transcript items={state.items} running={state.running} onRetry={sendPrompt} onCopy={client.copy} onRespond={client.respond} />
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => {
          sendPrompt(draft);
        }}
        rejection={threadId === undefined ? undefined : rejections.get(threadId)}
        canSend={state.thread !== undefined && !state.running && state.readOnly === null && draft.trim() !== ''}
        readOnly={state.readOnly}
        agentName={agentName}
        agent={state.thread?.agent}
        agentLocked={state.running || state.items.some((item) => item.kind === 'turn')}
        onAgentChange={client.setAgent}
        selectedModel={state.selectedModel}
        models={state.models}
        modelError={state.modelError}
        onModelChange={client.setModel}
        modelBusy={state.running}
        mode={state.mode}
        onModeChange={state.thread ? client.setMode : undefined}
        config={state.config}
        workspace={state.thread?.workspace ?? null}
        branch={state.branch}
      />
    </main>
  );
}

function rejectionReason(reason: PromptRejection): string {
  switch (reason) {
    case 'busy': return 'This thread is busy. Your message is still here.';
    case 'stale': return 'The shown thread changed. Your message is still here.';
    case 'empty': return 'Enter a message before sending.';
    case 'unknown': return 'This thread is no longer available. Your message is still here.';
    case 'read_only': return 'This thread is read-only. Start a new thread to go on.';
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
