import { Data, Deferred, Effect, Exit, Option, Schema, type Scope, Stream } from 'effect';
import type { StdioProcess } from './stdio';
import { WireMessage } from './traffic';

/** The agent answered a request with a JSON-RPC error. */
export class RpcError extends Data.TaggedError('RpcError')<{
  readonly code: number;
  readonly message: string;
  readonly data?: WireMessage;
}> {}

/** The connection closed before the agent answered; whoever watches the connection reports why. */
export class ConnectionClosed extends Data.TaggedError('ConnectionClosed')<{ readonly reason: string }> {}

/** The agent sent a message that does not match its schema. */
export class MalformedMessage extends Data.TaggedError('MalformedMessage')<{ readonly message: string }> {}

/** Decodes a message's params or result, failing with a {@link MalformedMessage} naming `what` it is. */
export function decodeMessage<A, I>(schema: Schema.Schema<A, I>, value: WireMessage | undefined, what: string): Effect.Effect<A, MalformedMessage> {
  return Effect.mapError(Schema.decodeUnknown(schema)(value), (error) => new MalformedMessage({ message: `sent a malformed ${what}: ${error.message}` }));
}

/** How a client answers what the agent sends it unprompted. */
export interface JsonRpcHandlers {
  /** Handles a notification. Failing ends the connection. */
  readonly notification: (method: string, params: WireMessage | undefined) => Effect.Effect<void, MalformedMessage>;
  /**
   * Answers a request from the agent; none replies "method not found". The answer is an effect of
   * its own, run on a fiber of the connection's, so an answer the user has to give (a permission
   * request) does not hold up the messages behind it. Failing to read the request ends the
   * connection.
   */
  readonly request: (method: string, params: WireMessage | undefined) => Effect.Effect<Option.Option<Effect.Effect<WireMessage>>, MalformedMessage>;
}

const METHOD_NOT_FOUND = -32601;
const LINE_PREVIEW_LENGTH = 200;

const RequestId = Schema.Union(Schema.Number, Schema.String);
type RequestId = typeof RequestId.Type;
const params = Schema.optional(WireMessage);

/** A JSON-RPC 2.0 message from the agent. `jsonrpc` is not checked, since Codex leaves it out. */
const Incoming = Schema.Union(
  Schema.Struct({ id: RequestId, method: Schema.String, params }).pipe(Schema.attachPropertySignature('kind', 'request')),
  Schema.Struct({ method: Schema.String, params }).pipe(Schema.attachPropertySignature('kind', 'notification')),
  Schema.Struct({ id: RequestId, result: WireMessage }).pipe(Schema.attachPropertySignature('kind', 'result')),
  Schema.Struct({
    id: RequestId,
    error: Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(WireMessage) }),
  }).pipe(Schema.attachPropertySignature('kind', 'error'))
);
type Incoming = typeof Incoming.Type;
const decodeIncoming = Schema.decodeEither(Schema.parseJson(Incoming));

/**
 * A JSON-RPC 2.0 client over an agent process's stdio, one message per line. One reader fiber
 * reads every line the agent sends: it settles pending requests, each waiting on a `Deferred`
 * keyed by its request ID, and passes notifications and requests to the handlers.
 *
 * The connection closes when the process exits or sends something it cannot read. Pending
 * requests then fail with {@link ConnectionClosed}, and `awaitClosed` says why.
 */
export class JsonRpcConnection {
  private nextId = 0;
  private readonly pending = new Map<RequestId, Deferred.Deferred<WireMessage, RpcError | ConnectionClosed>>();
  private closedReason: string | undefined;

  private constructor(
    private readonly process: StdioProcess,
    private readonly handlers: JsonRpcHandlers,
    private readonly closed: Deferred.Deferred<string>,
    /** Where answers that are not ready yet are awaited; closing it stops waiting for them. */
    private readonly scope: Scope.Scope
  ) {}

  /** Starts reading the process's messages. Closing the scope stops reading and fails pending requests. */
  static open(process: StdioProcess, handlers: JsonRpcHandlers): Effect.Effect<JsonRpcConnection, never, Scope.Scope> {
    return Effect.gen(function* () {
      const connection = new JsonRpcConnection(process, handlers, yield* Deferred.make<string>(), yield* Effect.scope);
      yield* Effect.addFinalizer(() => connection.close('the connection was closed'));
      yield* Effect.forkScoped(connection.read());
      return connection;
    });
  }

  /** Waits for the connection to close; succeeds with why it closed. */
  awaitClosed(): Effect.Effect<string> {
    return Deferred.await(this.closed);
  }

  /**
   * Sends a request and decodes the agent's result. A result that does not match `result` closes the
   * connection, as any other message the client cannot read does.
   */
  request<A, I>(method: string, params: WireMessage, result: Schema.Schema<A, I>): Effect.Effect<A, RpcError | ConnectionClosed> {
    return Effect.gen(this, function* () {
      if (this.closedReason !== undefined) {
        return yield* new ConnectionClosed({ reason: this.closedReason });
      }
      const id = ++this.nextId;
      const answer = yield* Deferred.make<WireMessage, RpcError | ConnectionClosed>();
      this.pending.set(id, answer);
      yield* this.send({ jsonrpc: '2.0', id, method, params });
      const value = yield* Deferred.await(answer);
      return yield* decodeMessage(result, value, `${method} result`).pipe(
        Effect.catchTag('MalformedMessage', ({ message }) => Effect.zipRight(this.close(message), new ConnectionClosed({ reason: message })))
      );
    });
  }

  notify(method: string, params?: WireMessage): Effect.Effect<void> {
    return this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  private send(message: WireMessage): Effect.Effect<void> {
    return this.process.send(JSON.stringify(message));
  }

  private read(): Effect.Effect<void> {
    return this.process.lines.pipe(
      Stream.runForEach((line) => Effect.mapError(this.receive(line), (error) => error.message)),
      Effect.as('the process exited'),
      Effect.merge,
      Effect.flatMap((reason) => this.close(reason))
    );
  }

  private receive(line: string): Effect.Effect<void, MalformedMessage> {
    return Effect.suspend(() => {
      if (this.closedReason !== undefined || !line.trim()) {
        return Effect.void;
      }
      const message = decodeIncoming(line);
      if (message._tag === 'Left') {
        const preview = line.length > LINE_PREVIEW_LENGTH ? `${line.slice(0, LINE_PREVIEW_LENGTH)}…` : line;
        return new MalformedMessage({ message: `sent a line that is not JSON-RPC: ${preview}` });
      }
      return this.dispatch(message.right);
    });
  }

  private dispatch(message: Incoming): Effect.Effect<void, MalformedMessage> {
    switch (message.kind) {
      case 'notification':
        return this.handlers.notification(message.method, message.params);
      case 'request':
        return Effect.flatMap(
          this.handlers.request(message.method, message.params),
          Option.match({
            onSome: (answer) => Effect.asVoid(Effect.forkIn(Effect.flatMap(answer, (result) => this.send({ jsonrpc: '2.0', id: message.id, result })), this.scope)),
            onNone: () =>
              Effect.zipRight(
                Effect.logDebug(`Declined an unsupported request from the agent: ${message.method}`),
                this.send({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } })
              ),
          })
        );
      case 'result':
        return this.settle(message.id, Exit.succeed(message.result));
      case 'error':
        return this.settle(message.id, Exit.fail(new RpcError(message.error)));
    }
  }

  private settle(id: RequestId, answer: Exit.Exit<WireMessage, RpcError>): Effect.Effect<void> {
    const pending = this.pending.get(id);
    if (!pending) {
      return Effect.logDebug(`Ignored a response to unknown request ${id}`);
    }
    this.pending.delete(id);
    return Deferred.done(pending, answer);
  }

  private close(reason: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closedReason !== undefined) {
        return Effect.void;
      }
      this.closedReason = reason;
      const pending = [...this.pending.values()];
      this.pending.clear();
      return Effect.zipRight(
        Effect.forEach(pending, (answer) => Deferred.fail(answer, new ConnectionClosed({ reason })), { discard: true }),
        Deferred.succeed(this.closed, reason)
      );
    });
  }
}
