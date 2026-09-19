import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Context, Deferred, Effect, Layer, Runtime, type Scope, Stream } from 'effect';

export interface StdioCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Replaces the environment the process inherits. */
  readonly env?: NodeJS.ProcessEnv;
}

/** A running agent process that speaks a line-based protocol over stdin and stdout. */
export interface StdioProcess {
  /** The lines the process writes to stdout. Fails with why the process stopped once it exits. */
  readonly lines: Stream.Stream<string, string>;
  /** Writes one line to the process's stdin. */
  send(line: string): Effect.Effect<void>;
}

/**
 * Starts agent processes that are spoken to over stdio (Codex's app-server, Cursor's ACP server).
 * Each process lives in the scope that spawns it: closing the scope kills it.
 */
export class Stdio extends Context.Tag('uni-agent/Stdio')<
  Stdio,
  { readonly spawn: (command: StdioCommand) => Effect.Effect<StdioProcess, never, Scope.Scope> }
>() {
  static readonly live = Layer.succeed(Stdio, { spawn: spawnProcess });
}

const STDERR_TAIL_LINES = 20;

function spawnProcess(command: StdioCommand): Effect.Effect<StdioProcess, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const name = path.basename(command.executable);
    const exited = yield* Deferred.make<string>();
    const stderrTail: string[] = [];

    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, stdio: 'pipe' })),
      (child) => Effect.sync(() => child.kill())
    );
    child.on('error', (error) => Deferred.unsafeDone(exited, Effect.succeed(`could not run ${command.executable}: ${error.message}`)));
    child.on('exit', (code, signal) =>
      Deferred.unsafeDone(exited, Effect.succeed(signal ? `the process was stopped by ${signal}` : `the process exited with code ${code}`))
    );
    // Writing to a process that has exited fails asynchronously; the exit itself is reported above.
    child.stdin.on('error', (error) => Runtime.runSync(runtime, Effect.logDebug(`Could not write to ${name}: ${error.message}`)));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) {
        Runtime.runSync(runtime, Effect.logDebug(`[${name} stderr] ${line}`));
        stderrTail.push(line);
        stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_TAIL_LINES));
      }
    });

    // The last lines of stderr usually explain why the process stopped.
    const stopped = Effect.flatMap(Deferred.await(exited), (reason) => {
      const stderr = stderrTail.join('\n').trim();
      return Effect.fail(reason + (stderr ? `\n\n${stderr}` : ''));
    });
    const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    return {
      lines: Stream.concat(
        Stream.fromAsyncIterable(stdout, (error) => (error instanceof Error ? error.message : String(error))),
        Stream.fromEffect(stopped)
      ),
      send: (line) => Effect.sync(() => void child.stdin.write(line + '\n')),
    };
  });
}
