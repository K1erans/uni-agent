import { Clock, Context, Data, Effect, Either, Layer, ParseResult, Schema } from 'effect';
import { AgentEvent, AgentKind, Mode, StopReason } from './agents/events';
import type { CompactedEvent } from './compaction';
import { Database, type DatabaseError, type Row } from './database';
import type { ThreadEvent } from './protocol';
import type { StoredHistory, ThreadFacts, ThreadRecord, Workspace } from './thread';
import type { Worktree } from './worktrees';

/** The thread store's schema, one migration per version (see `Database.layer`). */
export const THREAD_STORE_MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY NOT NULL,
    agent TEXT NOT NULL,
    model TEXT,
    mode TEXT NOT NULL,
    cwd TEXT NOT NULL,
    workspace_name TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    worktree_base TEXT,
    worktree_repo TEXT,
    session_id TEXT,
    title TEXT,
    status TEXT NOT NULL,
    read_only_reason TEXT,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE turns (
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE TABLE events (
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    part INTEGER NOT NULL,
    turn_id TEXT,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq, part)
  )`,
];

/** A thread as stored: everything needed to list it and restore it, but not its history. */
export interface StoredThread {
  readonly id: string;
  readonly agent: AgentKind;
  readonly model: string | undefined;
  readonly mode: Mode;
  readonly workspace: Workspace;
  readonly worktree: Worktree | undefined;
  /** The native session to resume; none if the agent never opened one. */
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  /** Why the thread is read-only, if it is. */
  readonly readOnly: string | undefined;
  readonly archived: boolean;
  /** When the thread last changed, in milliseconds since the epoch. */
  readonly updatedAt: number;
}

/** Who a thread is: what does not change over its life, given when its record is made. */
export interface RecordedThread {
  readonly id: string;
  readonly agent: AgentKind;
  readonly workspace: Workspace;
  readonly worktree: Worktree | undefined;
}

/** What the store could not read: a row it skipped, and why. */
export class UndecodableRow extends Data.TaggedError('UndecodableRow')<{ readonly table: string; readonly reason: string }> {}

/**
 * Keeps threads across reloads in the workspace's database: one row per thread (who it is and its
 * facts), one per turn, and one per transcript row a thread appends. It maps what threads give it
 * to rows and back, and knows nothing of how threads decide what to keep. Rows are decoded when
 * read and never cast; one that does not decode is logged and left out. Writing is best effort: a
 * failed write is logged and the thread carries on.
 */
export class ThreadStore extends Context.Tag('uni-agent/ThreadStore')<
  ThreadStore,
  {
    /**
     * Every stored thread, as `list` does, after ending the turns a reload or crash cut off (still
     * marked running) as `interrupted`. Run it once, before any thread is running.
     */
    readonly load: Effect.Effect<ReadonlyArray<StoredThread>>;
    /** Every stored thread, archived or not, most recently changed first. */
    readonly list: Effect.Effect<ReadonlyArray<StoredThread>>;
    readonly history: (threadId: string) => Effect.Effect<StoredHistory>;
    /** The record a thread keeps itself in; nothing is stored until the thread first saves. */
    readonly record: (thread: RecordedThread) => ThreadRecord;
    readonly setArchived: (threadId: string, archived: boolean) => Effect.Effect<void>;
    readonly remove: (threadId: string) => Effect.Effect<void>;
  }
>() {
  static readonly layer: Layer.Layer<ThreadStore, never, Database> = Layer.effect(
    ThreadStore,
    Effect.map(Database, (db) => makeStore(db))
  );

  /** A store in an in-memory database: nothing outlives the extension host. */
  static readonly memory: Layer.Layer<ThreadStore, DatabaseError> = ThreadStore.layer.pipe(
    Layer.provide(Database.layer(':memory:', THREAD_STORE_MIGRATIONS))
  );
}

const TurnStatus = Schema.Union(Schema.Literal('running'), StopReason);

const ThreadRow = Schema.Struct({
  id: Schema.String,
  agent: AgentKind,
  model: Schema.NullOr(Schema.String),
  mode: Mode,
  cwd: Schema.String,
  workspace_name: Schema.NullOr(Schema.String),
  worktree_path: Schema.NullOr(Schema.String),
  worktree_branch: Schema.NullOr(Schema.String),
  worktree_base: Schema.NullOr(Schema.String),
  worktree_repo: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  status: Schema.Literal('active', 'read_only'),
  read_only_reason: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Number),
  updated_at: Schema.Number,
});

const TurnRow = Schema.Struct({ thread_id: Schema.String, id: Schema.String, started_at: Schema.Number, status: TurnStatus });

const EventRow = Schema.Struct({ at: Schema.Number, payload: Schema.parseJson(AgentEvent) });

const NextSeqRow = Schema.Struct({ next: Schema.Number });
const LastAtRow = Schema.Struct({ last: Schema.NullOr(Schema.Number) });

const encodeEvent = Schema.encodeSync(Schema.parseJson(AgentEvent));

/** Decodes a row, reporting which table it came from if it does not fit. */
function decodeRow<A, I>(schema: Schema.Schema<A, I>, table: string, row: Row): Either.Either<A, UndecodableRow> {
  return Either.mapLeft(Schema.decodeUnknownEither(schema)(row), (error) =>
    new UndecodableRow({ table, reason: ParseResult.TreeFormatter.formatErrorSync(error) })
  );
}

function makeStore(db: Context.Tag.Service<Database>): Context.Tag.Service<ThreadStore> {
  /** Logs a failed write or read; the thread goes on without it. */
  const bestEffort = <A>(what: string, fallback: A) => (effect: Effect.Effect<A, DatabaseError>) =>
    Effect.catchAll(effect, (error) => Effect.as(Effect.logError(`Could not ${what}: ${error.reason}`, error.operation), fallback));

  const nextSeq = (threadId: string) =>
    Effect.flatMap(db.all('SELECT coalesce(max(seq) + 1, 0) AS next FROM events WHERE thread_id = ?', threadId), ([row]) =>
      Either.match(decodeRow(NextSeqRow, 'events', row ?? {}), { onLeft: () => Effect.succeed(0), onRight: ({ next }) => Effect.succeed(next) })
    );

  const insertEvents = (threadId: string, events: ReadonlyArray<CompactedEvent>) =>
    Effect.forEach(
      events,
      ({ seq, part, turnId, event, at }) =>
        db.run('INSERT INTO events (thread_id, seq, part, turn_id, at, payload) VALUES (?, ?, ?, ?, ?, ?)', threadId, seq, part, turnId ?? null, at, encodeEvent(event)),
      { discard: true }
    );

  /** Ends every turn still marked running, which only a reload or crash leaves behind. */
  const endInterruptedTurns = Effect.gen(function* () {
    const rows = yield* db.all("SELECT thread_id, id, started_at, status FROM turns WHERE status = 'running'");
    for (const row of rows) {
      const decoded = decodeRow(TurnRow, 'turns', row);
      if (Either.isLeft(decoded)) {
        yield* Effect.logWarning('Skipped a stored turn that could not be read', decoded.left.reason);
        continue;
      }
      const turn = decoded.right;
      const [last] = yield* db.all('SELECT max(at) AS last FROM events WHERE thread_id = ? AND turn_id = ?', turn.thread_id, turn.id);
      const endedAt = Either.match(decodeRow(LastAtRow, 'events', last ?? {}), { onLeft: () => turn.started_at, onRight: ({ last }) => last ?? turn.started_at });
      const seq = yield* nextSeq(turn.thread_id);
      yield* insertEvents(turn.thread_id, [{ seq, part: 0, turnId: turn.id, event: { type: 'turn_ended', turnId: turn.id, stopReason: 'interrupted' }, at: endedAt }]);
      yield* db.run("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE thread_id = ? AND id = ?", endedAt, turn.thread_id, turn.id);
    }
  });

  const list = Effect.gen(function* () {
    const rows = yield* db.all('SELECT * FROM threads ORDER BY updated_at DESC');
    const threads: StoredThread[] = [];
    for (const row of rows) {
      const decoded = decodeRow(ThreadRow, 'threads', row);
      if (Either.isLeft(decoded)) {
        yield* Effect.logError('Skipped a stored thread that could not be read', decoded.left.reason);
        continue;
      }
      threads.push(storedThread(decoded.right));
    }
    return threads;
  }).pipe(bestEffort<ReadonlyArray<StoredThread>>('load the stored threads', []));

  const load = Effect.zipRight(db.transaction(endInterruptedTurns).pipe(bestEffort<void>('end interrupted turns', undefined)), list);

  const history = (threadId: string) =>
    Effect.gen(function* () {
      const rows = yield* db.all('SELECT at, payload FROM events WHERE thread_id = ? ORDER BY seq, part', threadId);
      const events: ThreadEvent[] = [];
      let complete = true;
      for (const row of rows) {
        const decoded = decodeRow(EventRow, 'events', row);
        if (Either.isLeft(decoded)) {
          complete = false;
          yield* Effect.logError(`Skipped an event of thread ${threadId} that could not be read`, decoded.left.reason);
          continue;
        }
        events.push({ event: decoded.right.payload, at: decoded.right.at });
      }
      return { events, complete, nextSeq: yield* nextSeq(threadId) };
    }).pipe(bestEffort<StoredHistory>(`load the history of thread ${threadId}`, { events: [], complete: false, nextSeq: 0 }));

  const record = (thread: RecordedThread): ThreadRecord => ({
    // Insert or update: the first save stores the thread, later ones keep its facts current.
    save: (facts: ThreadFacts) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        db.run(
          `INSERT INTO threads (id, agent, model, mode, cwd, workspace_name, worktree_path, worktree_branch, worktree_base, worktree_repo,
             session_id, title, status, read_only_reason, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (id) DO UPDATE SET model = excluded.model, mode = excluded.mode, session_id = excluded.session_id,
             title = excluded.title, status = excluded.status, read_only_reason = excluded.read_only_reason`,
          thread.id, thread.agent, facts.model ?? null, facts.mode, thread.workspace.cwd, thread.workspace.name,
          thread.worktree?.path ?? null, thread.worktree?.branch ?? null, thread.worktree?.base ?? null, thread.worktree?.repo ?? null,
          facts.sessionId ?? null, facts.title ?? null, facts.readOnly === undefined ? 'active' : 'read_only', facts.readOnly ?? null, now, now
        )
      ).pipe(bestEffort<void>(`store thread ${thread.id}`, undefined)),
    // Turn boundaries among the rows keep the turns table, which the load after a crash reads.
    append: (rows: ReadonlyArray<CompactedEvent>) =>
      db.transaction(
        Effect.gen(function* () {
          for (const { event, at } of rows) {
            if (event.type === 'turn_started') {
              yield* db.run("INSERT INTO turns (thread_id, id, started_at, status) VALUES (?, ?, ?, 'running')", thread.id, event.turnId, at);
            } else if (event.type === 'turn_ended') {
              yield* db.run('UPDATE turns SET status = ?, ended_at = ? WHERE thread_id = ? AND id = ?', event.stopReason, at, thread.id, event.turnId);
            }
          }
          yield* insertEvents(thread.id, rows);
          if (rows.some(({ event }) => event.type === 'turn_started' || event.type === 'turn_ended')) {
            yield* db.run('UPDATE threads SET updated_at = ? WHERE id = ?', Math.max(...rows.map(({ at }) => at)), thread.id);
          }
        })
      ).pipe(bestEffort<void>(`store the transcript of thread ${thread.id}`, undefined)),
  });

  return {
    load,
    list,
    history,
    record,
    setArchived: (threadId, archived) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        db.run('UPDATE threads SET archived_at = ? WHERE id = ?', archived ? now : null, threadId)
      ).pipe(bestEffort<void>(`${archived ? 'archive' : 'unarchive'} thread ${threadId}`, undefined)),
    remove: (threadId) => db.run('DELETE FROM threads WHERE id = ?', threadId).pipe(bestEffort<void>(`delete thread ${threadId}`, undefined)),
  };
}

function storedThread(row: typeof ThreadRow.Type): StoredThread {
  const { worktree_path: path, worktree_branch: branch, worktree_base: base, worktree_repo: repo } = row;
  return {
    id: row.id,
    agent: row.agent,
    model: row.model ?? undefined,
    mode: row.mode,
    workspace: { cwd: row.cwd, name: row.workspace_name },
    worktree: path !== null && branch !== null && base !== null && repo !== null ? { path, branch, base, repo } : undefined,
    sessionId: row.session_id ?? undefined,
    title: row.title ?? undefined,
    readOnly: row.status === 'read_only' ? (row.read_only_reason ?? 'This thread is read-only.') : undefined,
    archived: row.archived_at !== null,
    updatedAt: row.updated_at,
  };
}
