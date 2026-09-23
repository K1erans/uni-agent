import { Effect, Option, Schema, Stream } from 'effect';
import type { ConnectionClosed, JsonRpcConnection, RpcError } from '../jsonRpc';
import { CLIENT_INFO } from '../jsonRpcSession';
import { WireMessage } from '../traffic';

/**
 * What Uni Agent knows of Codex's app-server protocol (`codex app-server generate-ts`) beyond one
 * session: how to start the server and greet it, and the models it offers. The session adapter
 * and model discovery both speak it through here, so the two cannot drift apart.
 */

/** The CLI on PATH, and the arguments that start its JSON-RPC server over stdio. */
export const CODEX_COMMAND = 'codex';
export const CODEX_ARGS: ReadonlyArray<string> = ['app-server'];

/** Greets a freshly started app-server; every other request waits for this. */
export function initializeCodex(rpc: JsonRpcConnection): Effect.Effect<void, RpcError | ConnectionClosed> {
  return Effect.zipRight(rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, WireMessage), rpc.notify('initialized'));
}

/** A model Codex offers. Older servers leave out the display name or the default flag. */
export const CodexModel = Schema.Struct({
  model: Schema.NonEmptyString,
  displayName: Schema.optional(Schema.NonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type CodexModel = typeof CodexModel.Type;

const ModelPage = Schema.Struct({ data: Schema.Array(CodexModel), nextCursor: Schema.NullOr(Schema.String) });

/**
 * Every model Codex offers, requested a page at a time as the stream is read, so a reader that
 * stops early (at the default model, say) asks for no more pages than it needs.
 */
export function codexModels(rpc: JsonRpcConnection): Stream.Stream<CodexModel, RpcError | ConnectionClosed> {
  // The first page is asked for without a cursor; each page names the next one, if there is one.
  return Stream.paginateEffect<string | undefined, ReadonlyArray<CodexModel>, RpcError | ConnectionClosed, never>(undefined, (cursor) =>
    Effect.map(
      rpc.request('model/list', cursor === undefined ? {} : { cursor }, ModelPage),
      (page) => [page.data, Option.fromNullable(page.nextCursor)] as const
    )
  ).pipe(Stream.flattenIterables);
}
