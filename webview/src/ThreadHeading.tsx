import { threadTitle } from '../../src/protocol';
import { AGENT_NAMES, STATUS_LABELS } from './labels';
import { agentStatus, type ThreadState } from './threadState';

interface ThreadHeadingProps {
  state: ThreadState;
}

/** The thread's title, and which agent it talks to, how that agent is doing, and where it runs. */
export function ThreadHeading({ state }: ThreadHeadingProps) {
  const firstTurn = state.items.find((item) => item.kind === 'turn');
  const title = firstTurn ? threadTitle(firstTurn.prompt) : 'New thread';
  const status = agentStatus(state);
  const problem = status !== 'ready' && status !== 'working';
  return (
    <header className="thread-heading">
      <h1 className="thread-title" title={title}>
        {title}
      </h1>
      <p className="thread-meta">
        <span className={`status-dot status-${status}`} role="img" aria-label={`Status: ${STATUS_LABELS[status]}`} title={STATUS_LABELS[status]} />
        <span className="meta-text meta-agent">{state.thread ? AGENT_NAMES[state.thread.agent] : 'Agent'}</span>
        {problem && (
          <>
            <span className="meta-separator" aria-hidden="true">
              ·
            </span>
            <span className="meta-text meta-problem">{STATUS_LABELS[status]}</span>
          </>
        )}
        <span className="meta-separator" aria-hidden="true">
          ·
        </span>
        <span className="meta-text meta-workspace" title={state.thread?.workspace ?? undefined}>
          {state.thread?.workspace ?? 'No folder open'}
        </span>
      </p>
    </header>
  );
}
