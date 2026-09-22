import { Effect, Layer, Option, Schema } from 'effect';
import type { AgentKind } from '../agents/events';
import { ModeSettings } from '../agents/modes';
import type { WireMessage } from '../agents/traffic';

/**
 * Mode settings as if the user had set each agent's `modeOverrides` to the raw value in
 * `settings`, decoded as `readSetting` does: a value that does not match counts as unset.
 */
export function modeSettings(settings: Partial<Record<AgentKind, WireMessage>>): Layer.Layer<ModeSettings> {
  return Layer.succeed(ModeSettings, {
    overrides: (agent, schema) =>
      Effect.succeed(agent in settings ? Schema.decodeUnknownOption(schema)(settings[agent]) : Option.none()),
  });
}
