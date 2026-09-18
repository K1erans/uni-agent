import * as fs from 'node:fs';
import * as os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { Data, Effect, type ParseResult, Option, Schema, Stream } from 'effect';

/** A message in the agent's own wire format, as JSON. */
export type WireMessage = string | number | boolean | null | readonly WireMessage[] | { readonly [key: string]: WireMessage };

const WireMessage: Schema.Schema<WireMessage> = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend(() => WireMessage)),
  Schema.Record({ key: Schema.String, value: Schema.suspend(() => WireMessage) })
);

/**
 * One line of an NDJSON traffic fixture: raw adapter traffic in the agent's own wire format.
 * `send` is what the adapter sent, `recv` what the agent sent back, and `exit` records the agent
 * process dying with an error. Lines read back from a fixture carry JSON; a recorder writes the
 * agent's typed messages.
 */
export type TrafficLine<Send = WireMessage, Recv = WireMessage> =
  | { dir: 'send'; data: Send }
  | { dir: 'recv'; data: Recv }
  | { dir: 'exit'; error: string };

const decodeTrafficLine = Schema.decode(
  Schema.parseJson(
    Schema.Union(
      Schema.Struct({ dir: Schema.Literal('send'), data: WireMessage }),
      Schema.Struct({ dir: Schema.Literal('recv'), data: WireMessage }),
      Schema.Struct({ dir: Schema.Literal('exit'), error: Schema.String })
    )
  )
);

export function parseTraffic(ndjson: string): Effect.Effect<TrafficLine[], ParseResult.ParseError> {
  return Effect.forEach(
    ndjson.split('\n').filter((line) => line.trim() !== ''),
    (line) => decodeTrafficLine(line)
  );
}

export function readTraffic(file: string): Effect.Effect<TrafficLine[], ParseResult.ParseError> {
  return Effect.sync(() => fs.readFileSync(file, 'utf8')).pipe(Effect.flatMap(parseTraffic));
}

/**
 * Appends raw traffic to an NDJSON fixture as it happens, so a crash still leaves the lines that
 * led up to it. The user's home directory is replaced with `~` so fixtures can be committed.
 */
export class TrafficRecorder<Send, Recv> {
  private readonly home = JSON.stringify(os.homedir()).slice(1, -1);

  private constructor(private readonly file: string) {}

  /** Starts an empty fixture at `file`, replacing any previous recording. */
  static make<Send, Recv>(file: string): Effect.Effect<TrafficRecorder<Send, Recv>> {
    return Effect.sync(() => {
      fs.writeFileSync(file, '');
      return new TrafficRecorder<Send, Recv>(file);
    });
  }

  send(data: Send): Effect.Effect<void> {
    return this.write({ dir: 'send', data });
  }

  recv(data: Recv): Effect.Effect<void> {
    return this.write({ dir: 'recv', data });
  }

  exit(error: string): Effect.Effect<void> {
    return this.write({ dir: 'exit', error });
  }

  private write(line: TrafficLine<Send, Recv>): Effect.Effect<void> {
    return Effect.sync(() => fs.appendFileSync(this.file, JSON.stringify(line).replaceAll(this.home, '~') + '\n'));
  }
}

/** The adapter sent a message the fixture did not record at that point. */
export class FixtureMismatch extends Data.TaggedError('FixtureMismatch')<{ readonly message: string }> {}

/** The fixture recorded the agent process dying here. */
export class RecordedExit extends Data.TaggedError('RecordedExit')<{ readonly message: string }> {}

/**
 * Plays a fixture back as a fake agent. It emits the `recv` lines recorded before the first
 * `send`, then, for each message the adapter sends, checks it matches the next recorded `send` and
 * emits the `recv` lines that followed it. An `exit` line fails the stream, as a crashed process
 * would. After the last line it waits, like an idle agent, until the adapter stops sending.
 */
export function replayTraffic<Sent, E>(
  lines: readonly TrafficLine[],
  sent: Stream.Stream<Sent, E>
): Stream.Stream<WireMessage, E | FixtureMismatch | RecordedExit> {
  return Stream.suspend(() => {
    let next = 0;

    const repliesUntilNextSend = Stream.repeatEffectOption(
      Effect.suspend(() => {
        const line = lines[next];
        if (!line || line.dir === 'send') {
          return Effect.fail(Option.none());
        }
        next++;
        return line.dir === 'exit' ? Effect.fail(Option.some(new RecordedExit({ message: line.error }))) : Effect.succeed(line.data);
      })
    );

    const expectSend = (message: Sent) =>
      Effect.suspend(() => {
        const expected = lines[next];
        if (expected?.dir !== 'send') {
          return new FixtureMismatch({ message: `Fixture has no recorded send for: ${JSON.stringify(message)}` });
        }
        if (!isDeepStrictEqual(message, expected.data)) {
          return new FixtureMismatch({
            message: `Sent message does not match the fixture.\nExpected: ${JSON.stringify(expected.data)}\nActual:   ${JSON.stringify(message)}`,
          });
        }
        next++;
        return Effect.void;
      });

    return Stream.concat(
      repliesUntilNextSend,
      Stream.flatMap(sent, (message) => Stream.concat(Stream.execute(expectSend(message)), repliesUntilNextSend))
    );
  });
}
