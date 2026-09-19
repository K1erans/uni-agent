import { Chunk, Effect, Either, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { Stdio, type StdioCommand } from './stdio';

/** Runs a Node script as the agent process. */
const node = (script: string): StdioCommand => ({ executable: process.execPath, args: ['-e', script], cwd: process.cwd() });

/** Spawns `command`, sends it `input`, and collects its stdout lines and why it stopped. */
function run(command: StdioCommand, input: string[] = []) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const stdio = yield* Stdio;
      const process = yield* stdio.spawn(command);
      yield* Effect.forEach(input, (line) => process.send(line), { discard: true });
      const lines: string[] = [];
      const stopped = yield* process.lines.pipe(
        Stream.runForEach((line) => Effect.sync(() => lines.push(line))),
        Effect.either
      );
      return { lines, stopped: Either.flip(stopped) };
    }).pipe(Effect.scoped, Effect.provide(Stdio.live))
  );
}

describe('Stdio.live', () => {
  it('streams stdout lines, then fails with the exit code and the tail of stderr', async () => {
    const { lines, stopped } = await run(
      node(`
        process.stdin.once('data', (data) => {
          process.stdout.write('echo ' + data);
          process.stderr.write('something broke\\n');
          process.exit(3);
        });
      `),
      ['hello']
    );

    expect(lines).toEqual(['echo hello']);
    expect(stopped).toEqual(Either.right('the process exited with code 3\n\nsomething broke'));
  });

  it('fails when the executable cannot be run', async () => {
    const { stopped } = await run({ executable: '/nonexistent/agent', args: [], cwd: process.cwd() });

    expect(stopped).toEqual(Either.right(expect.stringContaining('could not run /nonexistent/agent')));
  });

  it('kills the process when its scope closes', async () => {
    const pid = await Effect.runPromise(
      Effect.gen(function* () {
        const stdio = yield* Stdio;
        const agent = yield* stdio.spawn(node(`console.log(process.pid); setInterval(() => {}, 1000);`));
        return Number(Chunk.unsafeHead(yield* Stream.runCollect(Stream.take(agent.lines, 1))));
      }).pipe(Effect.scoped, Effect.provide(Stdio.live))
    );

    await expect.poll(() => isRunning(pid)).toBe(false);
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
