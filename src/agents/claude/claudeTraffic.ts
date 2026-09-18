import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Schema, Stream } from 'effect';
import { replayTraffic, type TrafficLine, type TrafficRecorder } from '../traffic';
import type { ClaudeQueryFn } from './claudeAdapter';

/** A reply as written to a fixture; see `redact`. */
type RecordedReply = Partial<SDKMessage>;

/**
 * Wraps a query function so its raw traffic is recorded: each user message the adapter sends and
 * each SDK message Claude sends back. Used to capture golden fixtures from the real binary.
 */
export function recordingQuery(query: ClaudeQueryFn, recorder: TrafficRecorder<SDKUserMessage, RecordedReply>): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const sent = Stream.fromAsyncIterable(prompt, (err) => err).pipe(Stream.tap((message) => recorder.send(message)));
    const inner = query({ prompt: Stream.toAsyncIterable(sent), options });
    const replies = Stream.fromAsyncIterable(inner, (err) => err).pipe(
      Stream.tap((message) => recorder.recv(redact(message))),
      Stream.tapError((err) => recorder.exit(err instanceof Error ? err.message : String(err)))
    );
    return {
      [Symbol.asyncIterator]: () => Stream.toAsyncIterable(replies)[Symbol.asyncIterator](),
      interrupt: () => inner.interrupt(),
      close: () => inner.close(),
    };
  };
}

/** A fake Claude that replays a recorded fixture instead of running the binary. */
export function replayQuery(lines: readonly TrafficLine[]): ClaudeQueryFn {
  return ({ prompt }) => {
    const replies = replayTraffic(lines, Stream.fromAsyncIterable(prompt, (err) => err)).pipe(
      // SAFETY: replayed replies are SDK messages recorded from the real binary, or hand-written in
      // tests with the fields the adapter reads. Redaction only drops fields the adapter never reads.
      Stream.map((reply) => reply as SDKMessage)
    );
    const replay = Stream.toAsyncIterable(replies)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => replay,
      interrupt: async () => undefined,
      close: () => void replay.return?.(),
    };
  };
}

const isSessionReply = Schema.is(Schema.Struct({ session_id: Schema.String }));

/** The session ID each recorded reply carries, or `undefined` for a reply without one. */
export function recordedSessionIds(lines: readonly TrafficLine[]): (string | undefined)[] {
  return lines.flatMap((line) => (line.dir === 'recv' ? [isSessionReply(line.data) ? line.data.session_id : undefined] : []));
}

/**
 * Keeps only a few fields of messages that describe the user's own setup: `system/init` lists
 * their tools, MCP servers and plugins, and `rate_limit_event` their plan's usage limits.
 */
function redact(message: SDKMessage): RecordedReply {
  if (message.type === 'system' && message.subtype === 'init') {
    const { type, subtype, cwd, session_id, model, permissionMode, claude_code_version, uuid } = message;
    return { type, subtype, cwd, session_id, model, permissionMode, claude_code_version, uuid };
  }
  if (message.type === 'rate_limit_event') {
    const { type, uuid, session_id } = message;
    return { type, uuid, session_id };
  }
  return message;
}
