import { Chunk, Context, Data, Effect, Layer, Option, Schema, Stream } from 'effect';
import { binaryMissingMessage } from './adapter';
import { ClaudeSdk } from './claude/claudeAdapter';
import { CLAUDE_COMMAND, claudeModels } from './claude/claudeProtocol';
import { CODEX_ARGS, CODEX_COMMAND, codexModels, initializeCodex } from './codex/codexProtocol';
import { CURSOR_ARGS, CURSOR_COMMAND, initializeCursor, modelChoices, SessionCreated } from './cursor/cursorProtocol';
import { ModelInfo, type AgentKind } from './events';
import { Executables } from './findExecutable';
import { JsonRpcConnection, type ConnectionClosed, type RpcError } from './jsonRpc';
import { Stdio } from './stdio';

const Models = Schema.Array(ModelInfo);

export class ModelDiscoveryFailed extends Data.TaggedError('ModelDiscoveryFailed')<{
  readonly agent: AgentKind;
  readonly message: string;
}> {}

const COMMANDS = { claude: CLAUDE_COMMAND, codex: CODEX_COMMAND, cursor: CURSOR_COMMAND } satisfies Record<AgentKind, string>;

/**
 * The models each agent offers, asked of the agent itself: each agent's protocol module knows how.
 * An agent's catalog is discovered once per CLI for the extension's lifetime, and a discovery
 * that fails is not remembered, so the next request tries again.
 */
export class ModelCatalog extends Context.Tag('uni-agent/ModelCatalog')<ModelCatalog, {
  readonly list: (agent: AgentKind, cwd: string, executablePath: Option.Option<string>) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelDiscoveryFailed>;
}>() {
  static readonly live = Layer.effect(ModelCatalog, Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const stdio = yield* Stdio;
    const executables = yield* Executables;
    const cache = new Map<string, ReadonlyArray<ModelInfo>>();

    /** Starts the agent's JSON-RPC server for one conversation, stopped when `talk` is done. */
    const talkTo = <A>(executable: string, args: ReadonlyArray<string>, cwd: string, talk: (rpc: JsonRpcConnection) => Effect.Effect<A, RpcError | ConnectionClosed>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* stdio.spawn({ executable, args, cwd });
          const rpc = yield* JsonRpcConnection.open(process, { notification: () => Effect.void, request: () => Effect.succeedNone });
          return yield* talk(rpc);
        })
      );

    const ask = (agent: AgentKind, executable: string, cwd: string): Effect.Effect<ReadonlyArray<ModelInfo>, string> => {
      const failure = (error: RpcError | ConnectionClosed) => (error._tag === 'ConnectionClosed' ? error.reason : error.message);
      switch (agent) {
        case 'claude':
          return Effect.map(claudeModels(sdk.query, executable, cwd), (models) => models.map(({ value, displayName }) => ({ id: value, name: displayName })));
        case 'codex':
          return talkTo(executable, CODEX_ARGS, cwd, (rpc) =>
            Effect.zipRight(initializeCodex(rpc), Stream.runCollect(codexModels(rpc)))
          ).pipe(
            Effect.map((models) => Chunk.toReadonlyArray(models).map(({ model, displayName }) => ({ id: model, name: displayName ?? model }))),
            Effect.mapError(failure)
          );
        case 'cursor':
          return talkTo(executable, CURSOR_ARGS, cwd, (rpc) =>
            Effect.zipRight(initializeCursor(rpc), rpc.request('session/new', { cwd, mcpServers: [] }, SessionCreated))
          ).pipe(
            Effect.map((session) => modelChoices(session).map(({ value, name }) => ({ id: value, name }))),
            Effect.mapError(failure)
          );
      }
    };

    const discover = (agent: AgentKind, cwd: string, executablePath: Option.Option<string>) =>
      Effect.gen(function* () {
        const executable = yield* executables.find(COMMANDS[agent], executablePath);
        if (Option.isNone(executable)) {
          return yield* new ModelDiscoveryFailed({ agent, message: binaryMissingMessage(agent, COMMANDS[agent], executablePath) });
        }
        const key = `${agent}\0${executable.value}`;
        const known = cache.get(key);
        if (known) {
          return known;
        }
        const models = yield* ask(agent, executable.value, cwd).pipe(
          Effect.flatMap((found) => Effect.mapError(Schema.decodeUnknown(Models)(found), (error) => error.message)),
          Effect.mapError((message) => new ModelDiscoveryFailed({ agent, message }))
        );
        if (models.length === 0) {
          return yield* new ModelDiscoveryFailed({ agent, message: 'The agent returned no models.' });
        }
        cache.set(key, models);
        return models;
      });

    return { list: discover };
  }));
}
