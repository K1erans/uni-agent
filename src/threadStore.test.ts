import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Effect, Either, Layer, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agents/events';
import { Database, type DatabaseError } from './database';
import { THREAD_STORE_MIGRATIONS, ThreadStore, type JournalledThread } from './threadStore';

/** A store over an in-memory database, with the database itself so a test can inspect or damage rows. */
function setup() {
  const layer = ThreadStore.layer.pipe(Layer.provideMerge(Database.layer(':memory:', THREAD_STORE_MIGRATIONS)));
  const services = Effect.runSync(Layer.build(layer).pipe(Scope.extend(Effect.runSync(Scope.make()))));
  const store = Context.get(services, ThreadStore);
  const db = Context.get(services, Database);
  return {
    store,
    run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect),
    rows: (sql: string) => Effect.runSync(db.all(sql)),
    exec: (sql: string) => Effect.runSync(db.run(sql)),
  };
}

const THREAD: JournalledThread = {
  id: 'thread-1',
  agent: 'codex',
  workspace: { cwd: '/work/uni-agent', name: 'uni-agent' },
  worktree: undefined,
  mode: 'auto_edit',
  model: undefined,
  stored: false,
};

const turnStarted = (turnId: string, text = 'Fix the build\nIt fails on CI'): AgentEvent => ({ type: 'turn_started', turnId, prompt: [{ type: 'text', text }] });
const say = (turnId: string, text: string): AgentEvent => ({
  type: 'session_update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', messageId: `${turnId}:m`, content: { type: 'text', text } },
});

describe('ThreadStore', () => {
  it('stores a thread from its first prompt, with the session the agent opened for it', () => {
    const { store, run } = setup();
    const journal = store.journal(THREAD);

    run(journal.setModel('gpt-6'));
    expect(run(store.list)).toEqual([]);

    run(journal.record(turnStarted('turn-1'), 100));
    // Codex and Cursor name their session once the first turn has opened it.
    run(journal.record({ type: 'session_started', agent: 'codex', sessionId: 'codex-thread' }, 101));
    run(journal.setMode('plan'));

    expect(run(store.list)).toEqual([
      {
        id: 'thread-1',
        agent: 'codex',
        model: 'gpt-6',
        mode: 'plan',
        workspace: { cwd: '/work/uni-agent', name: 'uni-agent' },
        worktree: undefined,
        sessionId: 'codex-thread',
        title: 'Fix the build',
        readOnly: undefined,
        archived: false,
        updatedAt: 100,
      },
    ]);
  });

  it('keeps a session announced before the first prompt, as Claude’s is', () => {
    const { store, run } = setup();
    const journal = store.journal({ ...THREAD, agent: 'claude' });

    run(journal.record({ type: 'session_started', agent: 'claude', sessionId: 'claude-session' }, 1));
    run(journal.record(turnStarted('turn-1'), 2));

    expect(run(store.list)[0]).toMatchObject({ agent: 'claude', sessionId: 'claude-session' });
  });

  it('gives back the compacted history in order, and adds to it after a restore', () => {
    const { store, run, rows } = setup();
    const journal = store.journal(THREAD);
    run(journal.record(turnStarted('turn-1'), 1));
    run(journal.record(say('turn-1', 'Hel'), 2));
    run(journal.record(say('turn-1', 'lo'), 3));
    run(journal.record({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' }, 4));

    // After a reload, the restored thread's journal carries on where the stored rows end.
    const restored = store.journal({ ...THREAD, stored: true });
    run(restored.record(turnStarted('turn-2', 'Again'), 5));
    run(restored.record({ type: 'turn_ended', turnId: 'turn-2', stopReason: 'cancelled' }, 6));

    expect(run(store.history('thread-1'))).toEqual({
      complete: true,
      events: [
        { event: turnStarted('turn-1'), at: 1 },
        { event: say('turn-1', 'Hello'), at: 2 },
        { event: { type: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' }, at: 4 },
        { event: turnStarted('turn-2', 'Again'), at: 5 },
        { event: { type: 'turn_ended', turnId: 'turn-2', stopReason: 'cancelled' }, at: 6 },
      ],
    });
    expect(rows('SELECT id, status FROM turns ORDER BY started_at')).toEqual([
      { id: 'turn-1', status: 'end_turn' },
      { id: 'turn-2', status: 'cancelled' },
    ]);
  });

  it('ends a turn a reload cut off as interrupted when it loads, keeping what had finished', () => {
    const { store, run } = setup();
    const journal = store.journal(THREAD);
    run(journal.record(turnStarted('turn-1'), 10));
    run(journal.record(say('turn-1', 'Working on it'), 11));
    run(journal.record({ type: 'session_update', turnId: 'turn-1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', kind: 'execute', status: 'in_progress' } }, 12));

    run(store.load);

    expect(run(store.history('thread-1')).events).toEqual([
      { event: turnStarted('turn-1'), at: 10 },
      { event: say('turn-1', 'Working on it'), at: 11 },
      { event: { type: 'turn_ended', turnId: 'turn-1', stopReason: 'interrupted' }, at: 11 },
    ]);
  });

  it('marks a thread read-only, and archives, restores and deletes it', () => {
    const { store, run, rows } = setup();
    const journal = store.journal(THREAD);
    run(journal.record(turnStarted('turn-1'), 1));
    run(journal.markReadOnly('Session can’t be resumed — start a new thread.'));

    run(store.setArchived('thread-1', true));
    expect(run(store.list)[0]).toMatchObject({ archived: true, readOnly: 'Session can’t be resumed — start a new thread.' });
    run(store.setArchived('thread-1', false));
    expect(run(store.list)[0]).toMatchObject({ archived: false });

    run(store.remove('thread-1'));
    expect(run(store.list)).toEqual([]);
    expect(rows('SELECT count(*) AS n FROM turns')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM events')).toEqual([{ n: 0 }]);
  });

  it('leaves out rows that do not decode, never casting them, and says the history is incomplete', () => {
    const { store, run, exec } = setup();
    const journal = store.journal(THREAD);
    run(journal.record(turnStarted('turn-1'), 1));
    run(journal.record({ type: 'turn_ended', turnId: 'turn-1', stopReason: 'end_turn' }, 2));
    exec(`UPDATE events SET payload = '{"type":"from_the_future"}' WHERE seq = 1`);
    run(store.journal({ ...THREAD, id: 'thread-2' }).record(turnStarted('turn-1'), 3));
    exec(`UPDATE threads SET agent = 'gemini' WHERE id = 'thread-2'`);

    expect(run(store.history('thread-1'))).toEqual({ complete: false, events: [{ event: turnStarted('turn-1'), at: 1 }] });
    expect(run(store.list).map((thread) => thread.id)).toEqual(['thread-1']);
  });
});

describe('Database', () => {
  /** Opens a database with these migrations, runs `use` against it, and closes it. */
  const withDatabase = <A>(location: string, migrations: ReadonlyArray<string>, use: (db: Context.Tag.Service<Database>) => Effect.Effect<A, DatabaseError | string>) =>
    Effect.runSync(Effect.either(Effect.scoped(Effect.flatMap(Layer.build(Database.layer(location, migrations)), (services) => use(Context.get(services, Database))))));

  it('brings the schema up to date, recording its version', () => {
    const version = withDatabase(':memory:', ['CREATE TABLE a (x)', 'CREATE TABLE b (y)'], (db) => db.all('PRAGMA user_version'));
    expect(version).toEqual(Either.right([{ user_version: 2 }]));
  });

  it('refuses a database newer than this build understands, and upgrades an older one', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-db-'));
    const file = path.join(folder, 'threads.db');
    try {
      expect(Either.isRight(withDatabase(file, ['CREATE TABLE a (x)'], () => Effect.void))).toBe(true);
      expect(withDatabase(file, [], () => Effect.void)).toEqual(Either.left(expect.objectContaining({ _tag: 'DatabaseError', operation: 'migrate' })));
      const upgraded = withDatabase(file, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)'], (db) => db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"));
      expect(upgraded).toEqual(Either.right([{ name: 'a' }, { name: 'b' }]));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('rolls a failed transaction back', () => {
    const count = withDatabase(':memory:', ['CREATE TABLE t (x INTEGER)'], (db) =>
      Effect.gen(function* () {
        yield* Effect.either(db.transaction(Effect.zipRight(db.run('INSERT INTO t VALUES (1)'), Effect.fail('boom'))));
        return yield* db.all('SELECT count(*) AS n FROM t');
      })
    );
    expect(count).toEqual(Either.right([{ n: 0 }]));
  });

  it('reports a COMMIT that fails, and leaves the connection ready for the next transaction', () => {
    // A deferred foreign key is only checked at COMMIT, which then fails and leaves the transaction open.
    const migrations = ['CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)'];
    const outcome = withDatabase(':memory:', migrations, (db) =>
      Effect.gen(function* () {
        const failed = yield* Effect.either(db.transaction(db.run('INSERT INTO child VALUES (7)')));
        yield* db.transaction(db.run('INSERT INTO parent VALUES (1)'));
        const children = yield* db.all('SELECT count(*) AS n FROM child');
        const parents = yield* db.all('SELECT count(*) AS n FROM parent');
        return { failed, children, parents };
      })
    );
    expect(outcome).toEqual(
      Either.right({
        failed: Either.left(expect.objectContaining({ _tag: 'DatabaseError', operation: 'COMMIT' })),
        children: [{ n: 0 }],
        parents: [{ n: 1 }],
      })
    );
  });
});
