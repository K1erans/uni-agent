import * as crypto from 'node:crypto';
import { Context, Effect, Layer } from 'effect';

/** Generates session and turn IDs. Session IDs are handed to agents, so they must be UUIDs. */
export class Ids extends Context.Tag('uni-agent/Ids')<Ids, { readonly next: Effect.Effect<string> }>() {
  static readonly live = Layer.succeed(Ids, { next: Effect.sync(() => crypto.randomUUID()) });
}
