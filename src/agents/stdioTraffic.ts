import { Effect, Option, Predicate, Queue, Schema, Stream, type Context } from 'effect';
import type { Stdio } from './stdio';
import { replayTraffic, WireMessage, type TrafficLine, type TrafficRecorder } from './traffic';

const decodeLine = Schema.decodeOption(Schema.parseJson(WireMessage));

/** A line as a fixture records it: its JSON, or the raw text for a line that is not JSON. */
function parseLine(line: string): WireMessage {
  return Option.getOrElse(decodeLine(line), () => line);
}

/** The line a recorded message was read from. */
function formatLine(message: WireMessage): string {
  return Predicate.isString(message) ? message : JSON.stringify(message);
}

/**
 * Fake agent processes that replay recorded fixtures instead of running a binary: the first spawn
 * replays the first fixture, the next spawn the next, and so on. Each checks the lines the adapter
 * sends against the fixture. A process whose fixture runs out waits, like an idle agent, until its
 * scope closes.
 */
export function replayStdio(fixtures: ReadonlyArray<readonly TrafficLine[]>): Context.Tag.Service<Stdio> {
  const remaining = [...fixtures];
  return {
    spawn: () =>
      Effect.gen(function* () {
        const traffic = remaining.shift() ?? [];
        const sent = yield* Effect.acquireRelease(Queue.unbounded<WireMessage>(), (queue) => Queue.shutdown(queue));
        return {
          lines: replayTraffic(traffic, Stream.fromQueue(sent)).pipe(
            Stream.map(formatLine),
            Stream.mapError((error) => error.message)
          ),
          send: (line) => Effect.asVoid(Queue.offer(sent, parseLine(line))),
        };
      }),
  };
}

/**
 * Wraps a process spawner so every line is recorded to a fixture: each message the adapter sends
 * and each message the agent sends back, passed through `redact` first so fixtures leave out the
 * user's own setup.
 */
export function recordingStdio(
  inner: Context.Tag.Service<Stdio>,
  recorder: TrafficRecorder<WireMessage, WireMessage>,
  redact: (message: WireMessage) => WireMessage
): Context.Tag.Service<Stdio> {
  return {
    spawn: (command) =>
      Effect.map(inner.spawn(command), (process) => ({
        lines: process.lines.pipe(
          Stream.tap((line) => recorder.recv(redact(parseLine(line)))),
          Stream.tapError((reason) => recorder.exit(reason))
        ),
        send: (line) => Effect.zipRight(recorder.send(parseLine(line)), process.send(line)),
      })),
  };
}

const isNotification = Schema.is(Schema.Struct({ method: Schema.String, params: WireMessage }));
/** A request carries an ID, since the agent is waiting for an answer to it. */
const isRequest = Schema.is(Schema.Struct({ id: Schema.Union(Schema.String, Schema.Number) }));

/**
 * Drops the params of every notification an adapter does not read, keeping its method so the
 * fixture still shows when it arrived. Unread notifications often describe the user's own setup.
 * Requests are kept whole: the adapter answers them, so a replay needs what they asked.
 */
export function redactUnreadNotifications(read: ReadonlySet<string>): (message: WireMessage) => WireMessage {
  return (message) => (isNotification(message) && !isRequest(message) && !read.has(message.method) ? { method: message.method } : message);
}

const hasCwd = Schema.is(Schema.Struct({ params: Schema.Struct({ cwd: Schema.String }) }));

/**
 * The working directory the adapter sent when the fixture was recorded, which a replay must send
 * too; any directory will do for a fixture that never sent one.
 */
export function recordedCwd(lines: readonly TrafficLine[]): string {
  for (const line of lines) {
    if (line.dir === 'send' && hasCwd(line.data)) {
      return line.data.params.cwd;
    }
  }
  return '/workspace';
}
