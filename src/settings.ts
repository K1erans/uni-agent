import { Effect, Layer, Option, Schema } from 'effect';
import * as vscode from 'vscode';
import { AGENT_NAMES } from './agents/events';
import { ModeSettings } from './agents/modes';

/** Reads a `uniAgent.*` setting; a value that does not match the schema counts as unset. */
export function readSetting<A, I>(key: string, schema: Schema.Schema<A, I>, resource?: vscode.Uri): Option.Option<A> {
  return Schema.decodeUnknownOption(schema)(vscode.workspace.getConfiguration('uniAgent', resource).get(key));
}

/**
 * Reads `uniAgent.<agent>.modeOverrides`. An override the user set that does not match is
 * ignored as a whole, so the agent keeps its built-in mapping, and the log says so.
 */
export const modeSettingsLive = Layer.succeed(ModeSettings, {
  overrides: (agent, schema) =>
    Effect.suspend(() => {
      const key = `${agent}.modeOverrides`;
      const overrides = readSetting(key, schema);
      const set = vscode.workspace.getConfiguration('uniAgent').inspect(key);
      const userSet = set !== undefined && [set.globalValue, set.workspaceValue, set.workspaceFolderValue].some((value) => value !== undefined);
      return Option.isNone(overrides) && userSet
        ? Effect.as(Effect.logWarning(`Ignored uniAgent.${key}, which is not valid; ${AGENT_NAMES[agent]} uses the built-in mode mapping`), overrides)
        : Effect.succeed(overrides);
    }),
});
