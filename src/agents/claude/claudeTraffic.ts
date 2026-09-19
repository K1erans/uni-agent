import type { CanUseTool, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Effect, Option, Queue, Schema, Stream } from 'effect';
import { replayTraffic, WireMessage, type TrafficLine, type TrafficRecorder } from '../traffic';
import type { ClaudeQueryFn } from './claudeAdapter';

/** A reply as written to a fixture; see `redact`. */
type RecordedReply = Partial<SDKMessage>;

/**
 * Claude asks permission through a callback rather than a message, so a fixture records the ask
 * and the answer in the shape the control protocol gives them: the ask as a reply Claude sent, the
 * answer as a message the adapter sent back. Replaying one calls the adapter's own callback.
 */
const ControlRequest = Schema.Struct({
  type: Schema.Literal('control_request'),
  request_id: Schema.String,
  request: Schema.Struct({
    subtype: Schema.Literal('can_use_tool'),
    tool_name: Schema.String,
    input: WireMessage,
    /** Everything else Claude says about the ask, passed back to the callback as it was recorded. */
    options: WireMessage,
  }),
});
type ControlRequest = typeof ControlRequest.Type;

const isControlRequest = Schema.is(ControlRequest);

/** The tool's own input, as JSON. */
const ToolInput = Schema.Record({ key: Schema.String, value: WireMessage });

/** What the adapter reads of an ask, kept in the fixture so a replay asks it the same way. */
const AskOptions = Schema.Struct({
  toolUseID: Schema.String,
  requestId: Schema.String,
  suggestions: Schema.optional(Schema.Array(WireMessage)),
  suppressAlwaysAllowRule: Schema.optional(Schema.Boolean),
});

/** Records a value the way JSON does, which drops the fields Claude left undefined. */
const decodeJson = Schema.decodeUnknownOption(Schema.parseJson(WireMessage));
const decodeToolInput = Schema.decodeUnknownOption(ToolInput);
const decodeAskOptions = Schema.decodeUnknownOption(AskOptions);

/** What a value that is not JSON is recorded as. */
const NOT_JSON = (): WireMessage => null;

function controlResponse(requestId: string, result: PermissionResult | null): WireMessage {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: Option.getOrElse(decodeJson(JSON.stringify(result)), NOT_JSON) },
  };
}

/**
 * Wraps a query function so its raw traffic is recorded: each user message the adapter sends, each
 * SDK message Claude sends back, and every permission the adapter is asked for and answers. Used to
 * capture golden fixtures from the real binary.
 */
export function recordingQuery(query: ClaudeQueryFn, recorder: TrafficRecorder<SDKUserMessage | WireMessage, RecordedReply | WireMessage>): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const sent = Stream.fromAsyncIterable(prompt, (err) => err).pipe(Stream.tap((message) => recorder.send(message)));
    const inner = query({ prompt: Stream.toAsyncIterable(sent), options: { ...options, canUseTool: recordingCanUseTool(options.canUseTool, recorder) } });
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

/** Records each ask and the answer it was given, as the lines a replay plays back. */
function recordingCanUseTool(inner: CanUseTool | undefined, recorder: TrafficRecorder<SDKUserMessage | WireMessage, RecordedReply | WireMessage>): CanUseTool | undefined {
  if (!inner) {
    return undefined;
  }
  let asks = 0;
  return async (toolName, input, request) => {
    const requestId = `can_use_tool-${++asks}`;
    const { signal: _signal, ...recordable } = request;
    await Effect.runPromise(
      recorder.recv({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: toolName,
          input: Option.getOrElse(decodeJson(JSON.stringify(input)), NOT_JSON),
          options: Option.getOrElse(decodeJson(JSON.stringify(recordable)), NOT_JSON),
        },
      })
    );
    const result = await inner(toolName, input, request);
    await Effect.runPromise(recorder.send(controlResponse(requestId, result)));
    return result;
  };
}

/**
 * A fake Claude that replays a recorded fixture instead of running the binary. A recorded ask is
 * put to the adapter's own permission callback, and the answer it gives is checked against the
 * answer the fixture recorded, like any other message the adapter sends.
 */
export function replayQuery(lines: readonly TrafficLine[]): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const replies = Stream.unwrap(
      Effect.gen(function* () {
        // The adapter answers asks on its own time, so answers join the messages it sends.
        const answers = yield* Queue.unbounded<WireMessage>();
        const sent = Stream.merge(Stream.fromAsyncIterable(prompt, (err) => err), Stream.fromQueue(answers));
        return replayTraffic(lines, sent).pipe(
          Stream.filterEffect((reply) =>
            // The ask is answered on a fiber of its own, since Claude keeps streaming while it waits.
            isControlRequest(reply) ? Effect.as(Effect.forkDaemon(answerAsk(reply, options.canUseTool, answers)), false) : Effect.succeed(true)
          ),
          // SAFETY: replayed replies are SDK messages recorded from the real binary, or hand-written in
          // tests with the fields the adapter reads. Redaction only drops fields the adapter never reads.
          Stream.map((reply) => reply as SDKMessage)
        );
      })
    );
    const replay = Stream.toAsyncIterable(replies)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => replay,
      interrupt: async () => undefined,
      close: () => void replay.return?.(),
    };
  };
}

/** Asks the adapter for permission and sends its answer back as the message the fixture expects. */
function answerAsk(ask: ControlRequest, canUseTool: CanUseTool | undefined, answers: Queue.Queue<WireMessage>): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!canUseTool) {
      return;
    }
    const { tool_name, input, options } = ask.request;
    const asked = Option.zipWith(decodeToolInput(input), decodeAskOptions(options), (toolInput, ask) => ({ toolInput, ask }));
    if (Option.isNone(asked)) {
      return yield* Effect.logWarning(`Skipped a recorded ${tool_name} ask that is not a permission request`);
    }
    const { toolInput, ask: recorded } = asked.value;
    const result = yield* Effect.promise(async () =>
      canUseTool(tool_name, { ...toolInput }, {
        signal: new AbortController().signal,
        toolUseID: recorded.toolUseID,
        requestId: recorded.requestId,
        // SAFETY: the suggestions are replayed as the JSON Claude recorded, and the adapter only
        // counts them and hands them back; nothing here reads their fields.
        suggestions: recorded.suggestions as PermissionUpdate[] | undefined,
        suppressAlwaysAllowRule: recorded.suppressAlwaysAllowRule,
      })
    );
    yield* Queue.offer(answers, controlResponse(ask.request_id, result));
  });
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
