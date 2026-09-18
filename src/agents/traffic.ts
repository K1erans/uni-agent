import * as fs from 'node:fs';
import * as os from 'node:os';
import { isDeepStrictEqual } from 'node:util';

/**
 * One line of an NDJSON traffic fixture: raw adapter traffic in the agent's own wire format.
 * `send` is what the adapter sent, `recv` what the agent sent back, and `exit` records the agent
 * process dying with an error.
 */
export type TrafficLine = { dir: 'send'; data: unknown } | { dir: 'recv'; data: unknown } | { dir: 'exit'; error: string };

export function parseTraffic(ndjson: string): TrafficLine[] {
  return ndjson
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrafficLine);
}

export function readTraffic(file: string): TrafficLine[] {
  return parseTraffic(fs.readFileSync(file, 'utf8'));
}

/**
 * Appends raw traffic to an NDJSON fixture as it happens, so a crash still leaves the lines that
 * led up to it. The user's home directory is replaced with `~` so fixtures can be committed.
 */
export class TrafficRecorder {
  private readonly home = JSON.stringify(os.homedir()).slice(1, -1);

  constructor(private readonly file: string) {
    fs.writeFileSync(file, '');
  }

  send(data: unknown): void {
    this.write({ dir: 'send', data });
  }

  recv(data: unknown): void {
    this.write({ dir: 'recv', data });
  }

  exit(error: string): void {
    this.write({ dir: 'exit', error });
  }

  private write(line: TrafficLine): void {
    fs.appendFileSync(this.file, JSON.stringify(line).replaceAll(this.home, '~') + '\n');
  }
}

/**
 * Plays a fixture back as a fake agent. It yields the `recv` lines recorded before the first
 * `send`, then, for each message the adapter sends, checks it matches the next recorded `send` and
 * yields the `recv` lines that followed it. An `exit` line throws, as a crashed process would.
 * After the last line it waits, like an idle agent, until the adapter stops sending.
 */
export async function* replayTraffic(lines: readonly TrafficLine[], sent: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let next = 0;

  function* repliesUntilNextSend(): Generator<unknown> {
    while (next < lines.length && lines[next].dir !== 'send') {
      const line = lines[next++];
      if (line.dir === 'exit') {
        throw new Error(line.error);
      }
      yield (line as { data: unknown }).data;
    }
  }

  yield* repliesUntilNextSend();
  for await (const message of sent) {
    const expected = lines[next];
    if (expected?.dir !== 'send') {
      throw new Error(`Fixture has no recorded send for: ${JSON.stringify(message)}`);
    }
    if (!isDeepStrictEqual(message, expected.data)) {
      throw new Error(
        `Sent message does not match the fixture.\nExpected: ${JSON.stringify(expected.data)}\nActual:   ${JSON.stringify(message)}`
      );
    }
    next++;
    yield* repliesUntilNextSend();
  }
}
