import { Clock, Context, Data, Effect, Either, Layer, ParseResult, Schema } from 'effect';
import { AgentEvent, AgentKind, Mode, StopReason } from './agents/events';
import { Compactor, type CompactedEvent } from './compaction';
import { Database, type DatabaseError, type Row } from './database';
import { threadTitle, type ThreadEvent } from './protocol';
import type { ThreadJournal, Workspace } from './thread';
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

/** A stored thread's history, in the order it happened. */
export interface StoredHistory {
  readonly events: ReadonlyArray<ThreadEvent>;
  /** False if some rows could not be decoded; they are left out of `events`. */
  readonly complete: boolean;
}

/** What a journal needs to know about its thread to store it. */
export interface JournalledThread {
  readonly id: string;
  readonly agent: AgentKind;
  readonly workspace: Workspace;
  readonly worktree: Worktree | undefined;
  readonly mode: Mode;
  readonly model: string | undefined;
  /** Whether the thread is already stored, as a restored one is. */
  readonly stored: boolean;
}

/** A thread's journal in the store. */
export interface StoreJournal extends ThreadJournal {
  /** Stores the thread now, before its first prompt; does nothing if it is stored already. */
  readonly keep: Effect.Effect<void>;
}

/** What the store could not read: a row it skipped, and why. */
export class UndecodableRow extends Data.TaggedError('UndecodableRow')<{ readonly table: string; readonly reason: string }> {}

/**
 * Keeps threads across reloads in the workspace's database: one row per thread, one per turn, and
 * one per compacted event (see `Compactor`). Rows are decoded when read and never cast; one that
 * does not decode is logged and left out. Writing is best effort: a failed write is logged and the
 * thread carries on.
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
    /**
     * Records a thread; it is stored from the moment its first prompt is accepted, or earlier if
     * `keep` is run (for a thread that already has something to keep, such as its worktree).
     */
    readonly journal: (thread: JournalledThread) => StoreJournal;
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
      return { events, complete };
    }).pipe(bestEffort<StoredHistory>(`load the history of thread ${threadId}`, { events: [], complete: false }));

  const journal = (thread: JournalledThread): StoreJournal => {
    let stored = thread.stored;
    let sessionId: string | undefined;
    let mode = thread.mode;
    let model = thread.model;
    let compactor: Compactor | undefined;

    const create = (title: string | null, at: number) =>
      db.run(
        `INSERT INTO threads (id, agent, model, mode, cwd, workspace_name, worktree_path, worktree_branch, worktree_base, worktree_repo,
           session_id, title, status, read_only_reason, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)`,
        thread.id, thread.agent, model ?? null, mode, thread.workspace.cwd, thread.workspace.name,
        thread.worktree?.path ?? null, thread.worktree?.branch ?? null, thread.worktree?.base ?? null, thread.worktree?.repo ?? null,
        sessionId ?? null, title, at, at
      );

    // A thread not stored yet has no rows, so its compactor starts at 0 without asking the database.
    const compactorFor = Effect.suspend(() => {
      if (compactor) {
        return Effect.succeed(compactor);
      }
      return Effect.map(stored ? nextSeq(thread.id) : Effect.succeed(0), (seq) => (compactor = new Compactor(seq)));
    });

    // Deltas only update the compactor; the database is touched only when there is a row to write.
    const record = (event: AgentEvent, at: number) =>
      Effect.gen(function* () {
        if (event.type === 'session_started') {
          sessionId = event.sessionId;
          if (stored) {
            yield* db.run('UPDATE threads SET session_id = ? WHERE id = ?', sessionId, thread.id);
          }
          return;
        }
        if (!stored && event.type !== 'turn_started') {
          return;
        }
        const rows = (yield* compactorFor).push(event, at);
        if (rows.length === 0) {
          return;
        }
        yield* db.transaction(
          Effect.gen(function* () {
            if (event.type === 'turn_started') {
              const title = threadTitle(event.prompt.map((block) => block.text).join('\n'));
              if (!stored) {
                yield* create(title, at);
                stored = true;
              }
              yield* db.run("INSERT INTO turns (thread_id, id, started_at, status) VALUES (?, ?, ?, 'running')", thread.id, event.turnId, at);
              // A thread kept before its first prompt is titled by that prompt.
              yield* db.run('UPDATE threads SET updated_at = ?, title = coalesce(title, ?) WHERE id = ?', at, title, thread.id);
            } else if (event.type === 'turn_ended') {
              yield* db.run('UPDATE turns SET status = ?, ended_at = ? WHERE thread_id = ? AND id = ?', event.stopReason, at, thread.id, event.turnId);
              yield* db.run('UPDATE threads SET updated_at = ? WHERE id = ?', at, thread.id);
            }
            yield* insertEvents(thread.id, rows);
          })
        );
      }).pipe(bestEffort<void>(`store an event of thread ${thread.id}`, undefined));

    const update = (what: string, sql: string, ...parameters: ReadonlyArray<string | null>) =>
      Effect.suspend(() => (stored ? db.run(sql, ...parameters, thread.id) : Effect.void)).pipe(bestEffort<void>(`store the ${what} of thread ${thread.id}`, undefined));

    return {
      record,
      keep: Effect.suspend(() =>
        stored ? Effect.void : Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.as(create(null, at), undefined)).pipe(Effect.tap(() => { stored = true; }))
      ).pipe(bestEffort<void>(`store thread ${thread.id}`, undefined)),
      setMode: (next) => Effect.suspend(() => {
        mode = next;
        return update('mode', 'UPDATE threads SET mode = ? WHERE id = ?', next);
      }),
      setModel: (next) => Effect.suspend(() => {
        model = next;
        return update('model', 'UPDATE threads SET model = ? WHERE id = ?', next ?? null);
      }),
      markReadOnly: (reason) => update('read-only state', "UPDATE threads SET status = 'read_only', read_only_reason = ? WHERE id = ?", reason),
    };
  };

  return {
    load,
    list,
    history,
    journal,
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
