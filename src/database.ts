import type * as sqlite from 'node:sqlite';
import { Cause, Context, Data, Effect, Exit, Layer, Option, Schema } from 'effect';

/** A value SQLite hands back for one column. */
export type SqlValue = sqlite.SQLOutputValue;

/** A value bound to a statement parameter. */
export type SqlParameter = sqlite.SQLInputValue;

/** One result row, by column name. Decode it with a schema before use; never cast it. */
export type Row = Readonly<Record<string, SqlValue>>;

/** A statement failed, or the database could not be opened. */
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ readonly operation: string; readonly reason: string }> {}

/**
 * The extension's SQLite database: a `node:sqlite` connection opened when the layer is built and
 * closed when its scope closes. Statements run synchronously on the extension host; every one is
 * small, so none holds it up for long.
 */
export class Database extends Context.Tag('uni-agent/Database')<
  Database,
  {
    /** Runs a statement that returns no rows. */
    readonly run: (sql: string, ...parameters: ReadonlyArray<SqlParameter>) => Effect.Effect<void, DatabaseError>;
    /** Runs a query and returns every row. */
    readonly all: (sql: string, ...parameters: ReadonlyArray<SqlParameter>) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>;
    /** Runs `effect` in one transaction, committed if it succeeds and rolled back if it fails. */
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseError, R>;
  }
>() {
  /**
   * Opens the database at `location` (a file path, or `:memory:`) and brings its schema up to date:
   * `migrations[i]` moves it from version `i` to `i + 1`, recorded in `PRAGMA user_version`.
   */
  static layer(location: string, migrations: ReadonlyArray<string>): Layer.Layer<Database, DatabaseError> {
    return Layer.scoped(
      Database,
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(open(location), (opened) =>
          Effect.sync(() => opened.close()).pipe(Effect.catchAllDefect((defect) => Effect.logWarning('Could not close the database', defect)))
        );
        const service = makeService(db);
        yield* migrate(service, migrations);
        return service;
      })
    );
  }
}

function open(location: string): Effect.Effect<sqlite.DatabaseSync, DatabaseError> {
  return Effect.try({
    try: () => {
      // Loaded here rather than imported, so a VS Code whose Node lacks it still activates far
      // enough to explain why (see nodeSqlite.ts).
      const { DatabaseSync }: typeof sqlite = require('node:sqlite');
      const db = new DatabaseSync(location, { enableForeignKeyConstraints: true });
      if (location !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL');
      }
      return db;
    },
    catch: (error) => new DatabaseError({ operation: `open ${location}`, reason: reasonOf(error) }),
  });
}

function makeService(db: sqlite.DatabaseSync): Context.Tag.Service<Database> {
  let depth = 0;
  const attempt = <A>(operation: string, f: () => A) =>
    Effect.try({ try: f, catch: (error) => new DatabaseError({ operation, reason: reasonOf(error) }) });
  const rollback = attempt('ROLLBACK', () => db.exec('ROLLBACK'));
  // A COMMIT that fails (a busy or full disk, say) can leave the transaction open, so it is rolled
  // back before the failure is reported and the next BEGIN finds the connection idle. SQLite may
  // have rolled it back itself already, which makes the ROLLBACK fail; only the COMMIT's error counts.
  const commit = attempt('COMMIT', () => db.exec('COMMIT')).pipe(
    Effect.tapError(() => Effect.catchAll(rollback, (error) => Effect.logDebug('No transaction left to roll back after a failed COMMIT', error)))
  );
  return {
    run: (sql, ...parameters) => Effect.asVoid(attempt(sql, () => db.prepare(sql).run(...parameters))),
    all: (sql, ...parameters) => attempt(sql, () => db.prepare(sql).all(...parameters)),
    // Nested transactions join the outer one, which commits or rolls back all of it. Transactions
    // only wrap synchronous statements, so no other fiber's statement can run inside one.
    transaction: (effect) =>
      Effect.suspend(() => {
        if (depth > 0) {
          return effect;
        }
        // A transaction that could not be ended fails, so its writes are never taken as saved.
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* attempt('BEGIN', () => {
              db.exec('BEGIN');
              depth++;
            });
            const exit = yield* Effect.exit(restore(effect));
            depth--;
            if (Exit.isSuccess(exit)) {
              yield* commit;
              return exit.value;
            }
            return yield* rollback.pipe(
              Effect.catchAll((error) => Effect.failCause(Cause.sequential(exit.cause, Cause.fail(error)))),
              Effect.zipRight(exit)
            );
          })
        );
      }),
  };
}

function migrate(db: Context.Tag.Service<Database>, migrations: ReadonlyArray<string>): Effect.Effect<void, DatabaseError> {
  return db.transaction(
    Effect.gen(function* () {
      const [row] = yield* db.all('PRAGMA user_version');
      const version = Option.match(decodeVersion(row), { onNone: () => 0, onSome: ({ user_version }) => user_version });
      if (version > migrations.length) {
        return yield* new DatabaseError({
          operation: 'migrate',
          reason: `The database is at version ${version}, newer than this build of Uni Agent understands (${migrations.length}).`,
        });
      }
      for (const [index, sql] of migrations.entries()) {
        if (index >= version) {
          yield* Effect.forEach(statements(sql), (statement) => db.run(statement), { discard: true });
        }
      }
      if (version < migrations.length) {
        yield* db.run(`PRAGMA user_version = ${migrations.length}`);
      }
    })
  );
}

/** Splits a migration into its statements, since a prepared statement runs only one. */
function statements(sql: string): ReadonlyArray<string> {
  return sql.split(';').map((statement) => statement.trim()).filter(Boolean);
}

const decodeVersion = Schema.decodeUnknownOption(Schema.Struct({ user_version: Schema.Number }));

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
