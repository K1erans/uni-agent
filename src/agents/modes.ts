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

/** The native settings a mode runs with, and an override that was set for it but ignored. */
export interface NativeChoice<A> {
  readonly native: A;
  readonly ignored: Option.Option<A>;
}

/**
 * The native settings for `mode`: the override set for it, otherwise the built-in mapping. An
 * override may only make a mode stricter: one that `noLooser` says grants more than the built-in
 * setting is ignored, so no setting can give a mode more freedom than its name promises.
 */
export function nativeMode<A>(
  mode: Mode,
  builtIn: (mode: Mode) => A,
  overrides: Option.Option<ModeOverrides<A>>,
  noLooser: (override: A, builtIn: A) => boolean
): NativeChoice<A> {
  const mapped = builtIn(mode);
  return Option.match(
    Option.flatMap(overrides, (set) => Option.fromNullable(set[mode])),
    {
      onNone: () => ({ native: mapped, ignored: Option.none() }),
      onSome: (override) =>
        noLooser(override, mapped) ? { native: override, ignored: Option.none() } : { native: mapped, ignored: Option.some(override) },
    }
  );
}
