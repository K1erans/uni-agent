import { memo, useLayoutEffect, useRef } from 'react';
import type { TranscriptItem } from './threadState';

/** How close to the bottom (px) still counts as following the stream. */
const FOLLOW_THRESHOLD = 48;

export function Transcript({ items, running }: { items: TranscriptItem[]; running: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const following = useRef(true);

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
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
      }}
    >
      {items.length === 0 && <p className="empty-state">No messages yet.</p>}
      {items.map((item) => (
        <TranscriptItemView key={item.id} item={item} />
      ))}
      {running && items.at(-1)?.kind === 'user' && <p className="working">Working…</p>}
    </section>
  );
}

/** Memoised on the item object, which the reducer only replaces for the item that changed. */
export const TranscriptItemView = memo(function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="item item-user">{item.text}</div>;
    case 'agent_message':
      return <div className="item item-agent">{item.text}</div>;
    case 'agent_thought':
      return (
        <details className="item item-thought">
          <summary>Thinking</summary>
          {item.text}
        </details>
      );
    case 'error':
      return (
        <div className="item item-error" role="alert">
          {item.message}
        </div>
      );
  }
});
