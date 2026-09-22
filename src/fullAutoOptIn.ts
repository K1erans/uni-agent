import { Context, Effect, Layer, Option, Schema } from 'effect';
import type * as vscode from 'vscode';

const KEY = 'uniAgent.fullAutoOptIn';
const decodeOptIn = Schema.decodeUnknownOption(Schema.Boolean);

/**
 * Whether the user has allowed Full auto in this workspace. They confirm it once, and it is
 * remembered for the workspace; until then, no thread in it can switch to Full auto.
 */
export class FullAutoOptIn extends Context.Tag('uni-agent/FullAutoOptIn')<
  FullAutoOptIn,
  {
    readonly granted: Effect.Effect<boolean>;
    /** Remembers that the user allowed Full auto in this workspace. */
    readonly grant: Effect.Effect<void>;
  }
>() {
  /** Keeps the opt-in in the workspace's state; a value an older build stored in another shape counts as not opted in. */
  static live(state: vscode.Memento): Layer.Layer<FullAutoOptIn> {
    return Layer.succeed(FullAutoOptIn, {
      granted: Effect.sync(() => Option.getOrElse(decodeOptIn(state.get(KEY)), () => false)),
      grant: Effect.promise(async () => state.update(KEY, true)),
    });
  }
}
