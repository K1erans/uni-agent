import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StopReason } from '../../src/agents/events';
import { ChevronDownIcon } from './icons';
import { ERROR_TITLES, formatDuration } from './labels';
import type { ErrorItem, TextItem, TranscriptItem, TurnItem } from './threadState';

/** How close to the bottom (px) still counts as following the stream. */
const FOLLOW_THRESHOLD = 48;
/** How long "Copied" shows after copying a response. */
const COPIED_MS = 1500;

/** Why a turn ended, when that is worth telling the user; errors explain themselves. */
const STOP_NOTES = {
  cancelled: 'Cancelled',
  max_tokens: 'Stopped at the output limit',
  max_turn_requests: 'Stopped at the turn limit',
  refusal: 'The agent declined to continue',
  end_turn: undefined,
  error: undefined,
} satisfies Record<StopReason, string | undefined>;

interface TranscriptProps {
  items: TranscriptItem[];
  running: boolean;
  /** Sends a prompt again; only offered on the latest turn. Must keep its identity across renders. */
  onRetry: (prompt: string) => void;
  /** Copies text to the clipboard. Must keep its identity across renders. */
  onCopy: (text: string) => void;
}

export function Transcript({ items, running, onRetry, onCopy }: TranscriptProps) {
  const ref = useRef<HTMLElement>(null);
  const following = useRef(true);
  const lastTurnIndex = items.findLastIndex((item) => item.kind === 'turn');
  const lastTurnId = items[lastTurnIndex]?.id;

  // A new turn means the user just sent a prompt, so bring it into view.
  useLayoutEffect(() => {
    following.current = true;
  }, [lastTurnId]);

  // Keep the newest output in view while the user has not scrolled up to read.
  useLayoutEffect(() => {
    if (following.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [items]);

  return (
    <section
      ref={ref}
      className={items.length === 0 ? 'transcript transcript-empty' : 'transcript'}
      aria-label="Conversation"
      aria-live="polite"
      aria-busy={running}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
      }}
    >
      {items.length === 0 && <p className="empty-state">No messages yet.</p>}
      {items.map((item, index) =>
        item.kind === 'turn' ? (
          <TurnView
            key={item.id}
            turn={item}
            latest={index === lastTurnIndex}
            running={index === lastTurnIndex && running}
            onRetry={onRetry}
            onCopy={onCopy}
          />
        ) : (
          <ErrorCard key={item.id} error={item} />
        )
      )}
    </section>
  );
}

interface TurnViewProps {
  turn: TurnItem;
  /** Whether this is the thread's most recent turn, the only one offering Retry. */
  latest: boolean;
  /** Whether a turn is running or starting; always false for earlier turns, so they stay memoised. */
  running: boolean;
  onRetry: (prompt: string) => void;
  onCopy: (text: string) => void;
}

/** Memoised on the turn object, which the reducer only replaces for the turn that changed. */
const TurnView = memo(function TurnView({ turn, latest, running, onRetry, onCopy }: TurnViewProps) {
  const ended = turn.stopReason !== undefined;
  const waiting = !ended && turn.messages.length === 0 && turn.thoughts.length === 0 && turn.errors.length === 0;
  return (
    <article className="turn">
      <div className="user-message">{turn.prompt}</div>
      <Activity turn={turn} />
      {turn.messages.map((message) => (
        <AgentMessage key={message.id} message={message} />
      ))}
      {waiting && <p className="working">Working…</p>}
      {turn.errors.map((error) => (
        <ErrorCard key={error.id} error={error} />
      ))}
      {ended && (
        <ResponseFooter
          note={turn.stopReason && STOP_NOTES[turn.stopReason]}
          reply={turn.messages.map((message) => message.text).join('\n\n')}
          retry={latest ? (running ? 'disabled' : 'enabled') : 'hidden'}
          onRetry={() => onRetry(turn.prompt)}
          onCopy={onCopy}
        />
      )}
    </article>
  );
});

/** What the agent did before replying: its thinking, which expands, and how long the turn took. */
function Activity({ turn }: { turn: TurnItem }) {
  const ended = turn.endedAt !== undefined;
  const duration = turn.endedAt === undefined ? undefined : formatDuration(turn.endedAt - turn.startedAt);
  if (turn.thoughts.length === 0) {
    return duration !== undefined && turn.messages.length > 0 ? <p className="activity">Worked for {duration}</p> : null;
  }
  return (
    <details className="activity">
      <summary className="activity-summary">
        <ChevronDownIcon size={12} className="activity-chevron" />
        <span>{ended ? 'Thought' : 'Thinking…'}</span>
        {duration !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <span>{duration}</span>
          </>
        )}
      </summary>
      <div className="activity-body">
        {turn.thoughts.map((thought) => (
          <p key={thought.id}>{thought.text}</p>
        ))}
      </div>
    </details>
  );
}

/** Memoised on the text item, so only the one streaming re-renders. */
export const AgentMessage = memo(function AgentMessage({ message }: { message: TextItem }) {
  return <div className="agent-message">{message.text}</div>;
});

function ErrorCard({ error }: { error: ErrorItem }) {
  return (
    <div className="error-card" role="alert">
      <p className="error-title">{ERROR_TITLES[error.code]}</p>
      <p className="error-message">{error.message}</p>
    </div>
  );
}

interface ResponseFooterProps {
  note: string | undefined;
  /** The reply's text; Copy is offered only when there is some. */
  reply: string;
  retry: 'enabled' | 'disabled' | 'hidden';
  onRetry: () => void;
  onCopy: (text: string) => void;
}

function ResponseFooter({ note, reply, retry, onRetry, onCopy }: ResponseFooterProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!note && !reply && retry === 'hidden') {
    return null;
  }
  return (
    <div className="response-footer">
      {note && <span className="response-note">{note}</span>}
      <span className="spacer" />
      {reply && (
        <button
          type="button"
          className="text-button"
          aria-label="Copy response"
          onClick={() => {
            onCopy(reply);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
      {retry !== 'hidden' && (
        <button type="button" className="text-button" aria-label="Retry prompt" disabled={retry === 'disabled'} onClick={onRetry}>
          Retry
        </button>
      )}
      <span className="sr-only" role="status">
        {copied ? 'Response copied to clipboard' : ''}
      </span>
    </div>
  );
}
