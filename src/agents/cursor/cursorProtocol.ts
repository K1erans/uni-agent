import { Effect, Option, Schema } from 'effect';
import type { ConnectionClosed, JsonRpcConnection, RpcError } from '../jsonRpc';
import { CLIENT_INFO } from '../jsonRpcSession';
import { WireMessage } from '../traffic';

/**
 * What Uni Agent knows of the Agent Client Protocol (https://agentclientprotocol.com) as Cursor's
 * agent CLI speaks it, beyond one session: how to start and greet it, and how a session offers
 * models. The session adapter and model discovery both speak it through here, so the models the
 * picker lists are the ones the session can select.
 */

/** The CLI on PATH, and the arguments that start its ACP server over stdio. */
export const CURSOR_COMMAND = 'agent';
export const CURSOR_ARGS: ReadonlyArray<string> = ['acp'];

const PROTOCOL_VERSION = 1;

/** ACP's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

const Initialized = Schema.Struct({
  agentCapabilities: Schema.optional(Schema.Struct({ loadSession: Schema.optional(Schema.Boolean) })),
});

/** What the agent said it can do when greeted. */
export interface CursorCapabilities {
  /** Whether it can load a stored session with `session/load`. */
  readonly loadSession: boolean;
}

/** Greets a freshly started agent, offering no client capabilities (file system, terminals) yet. */
export function initializeCursor(rpc: JsonRpcConnection): Effect.Effect<CursorCapabilities, RpcError | ConnectionClosed> {
  return Effect.map(
    rpc.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO },
      Initialized
    ),
    ({ agentCapabilities }) => ({ loadSession: agentCapabilities?.loadSession === true })
  );
}

/** The result of `session/new` and `session/load`: the session's model and mode, when the agent has them. */
export const SessionOpened = Schema.Struct({
  configOptions: Schema.optional(Schema.Array(WireMessage)),
  models: Schema.optional(
    Schema.Struct({
      currentModelId: Schema.String,
      availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })),
    })
  ),
  modes: Schema.optional(
    Schema.Struct({ currentModeId: Schema.String, availableModes: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))) })
  ),
});
export type SessionOpened = typeof SessionOpened.Type;

export const SessionCreated = Schema.Struct({ sessionId: Schema.String, ...SessionOpened.fields });

/** The answer to `session/set_config_option`: every config option as it now stands. */
export const ConfigOptionsChanged = Schema.Struct({ configOptions: Schema.Array(WireMessage) });

/** A session's model picker, as a select config option. */
const ModelConfigOption = Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.String),
  type: Schema.Literal('select'),
  currentValue: Schema.String,
  options: Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })),
});
export type ModelConfigOption = typeof ModelConfigOption.Type;
const decodeModelConfigOption = Schema.decodeUnknownOption(ModelConfigOption);

/**
 * The model config option among a session's config options: the one with ID `id`, or else the
 * one that is about models. Options of other kinds, or that do not decode, are passed over.
 */
export function modelConfig(configOptions: ReadonlyArray<WireMessage> | undefined, id?: string): ModelConfigOption | undefined {
  return configOptions
    ?.map((option) => Option.getOrUndefined(decodeModelConfigOption(option)))
    .find((option) => (id === undefined ? option?.category === 'model' || option?.id === 'model' : option?.id === id));
}

/** A model the session can be switched to: the value to send, and its name. */
export interface ModelChoice {
  readonly value: string;
  readonly name: string;
}

/**
 * The models a session offers, as its model config option lists them, since that is what
 * selecting a model sets; or, for an agent without one, its list of available models.
 */
export function modelChoices(session: SessionOpened): ReadonlyArray<ModelChoice> {
  return modelConfig(session.configOptions)?.options ?? session.models?.availableModels.map(({ modelId, name }) => ({ value: modelId, name })) ?? [];
}
