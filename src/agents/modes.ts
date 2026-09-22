import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { AgentKind, Mode } from './events';

/**
 * Each agent's advanced `uniAgent.<agent>.modeOverrides` setting: for any mode, the agent's own
 * native settings to use instead of the built-in mapping. A mode left out keeps the built-in one.
 */
export function modeOverrides<A, I>(native: Schema.Schema<A, I>) {
  return Schema.Struct({ plan: Schema.optional(native), auto_edit: Schema.optional(native), full_auto: Schema.optional(native) });
}

export type ModeOverrides<A> = { readonly [M in Mode]?: A };

/**
 * Reads an agent's mode overrides. A value that does not match the schema counts as unset, so the
 * built-in mapping applies; the live layer logs that it was ignored.
 */
export class ModeSettings extends Context.Tag('uni-agent/ModeSettings')<
  ModeSettings,
  { readonly overrides: <A, I>(agent: AgentKind, schema: Schema.Schema<A, I>) => Effect.Effect<Option.Option<A>> }
>() {
  /** No overrides set: every agent uses its built-in mapping. */
  static readonly none = Layer.succeed(ModeSettings, { overrides: () => Effect.succeedNone });
}

/** The native settings for `mode`: the override if one is set for it, otherwise the built-in mapping. */
export function nativeMode<A>(mode: Mode, builtIn: (mode: Mode) => A, overrides: Option.Option<ModeOverrides<A>>): A {
  return Option.getOrElse(
    Option.flatMap(overrides, (set) => Option.fromNullable(set[mode])),
    () => builtIn(mode)
  );
}
