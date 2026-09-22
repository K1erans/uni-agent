import { Context, Data, Effect, Layer, Option, Schema, Stream } from 'effect';
import { ModelInfo, type AgentKind } from './events';
import { ClaudeSdk } from './claude/claudeAdapter';
import { Executables } from './findExecutable';
import { JsonRpcConnection } from './jsonRpc';
import { CLIENT_INFO } from './jsonRpcAdapter';
import { Stdio } from './stdio';
import { WireMessage } from './traffic';

const Models = Schema.Array(ModelInfo);
const ClaudeModels = Schema.Array(Schema.Struct({ value: Schema.NonEmptyString, displayName: Schema.NonEmptyString }));
const CodexPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ model: Schema.NonEmptyString, displayName: Schema.NonEmptyString })),
  nextCursor: Schema.NullOr(Schema.String),
});
const CursorSession = Schema.Struct({
  configOptions: Schema.optional(Schema.Array(WireMessage)),
  models: Schema.optional(Schema.Struct({
    availableModels: Schema.Array(Schema.Struct({ modelId: Schema.NonEmptyString, name: Schema.NonEmptyString })),
  })),
});
const CursorModelConfig = Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.String),
  type: Schema.Literal('select'),
  options: Schema.Array(Schema.Struct({ value: Schema.NonEmptyString, name: Schema.NonEmptyString })),
});

export class ModelDiscoveryFailed extends Data.TaggedError('ModelDiscoveryFailed')<{
  readonly agent: AgentKind;
  readonly message: string;
}> {}

/** A catalog is discovered once per agent for the extension's lifetime. */
export class ModelCatalog extends Context.Tag('uni-agent/ModelCatalog')<ModelCatalog, {
  readonly list: (agent: AgentKind, cwd: string, executablePath: Option.Option<string>) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelDiscoveryFailed>;
}>() {
  static readonly live = Layer.effect(ModelCatalog, Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const stdio = yield* Stdio;
    const executables = yield* Executables;
    const cache = new Map<AgentKind, Effect.Effect<ReadonlyArray<ModelInfo>, ModelDiscoveryFailed>>();

    const discover = (agent: AgentKind, cwd: string, executablePath: Option.Option<string>): Effect.Effect<ReadonlyArray<ModelInfo>, ModelDiscoveryFailed> =>
      Effect.gen(function* () {
        const command = agent === 'cursor' ? 'agent' : agent;
        const executable = yield* executables.find(command, executablePath);
        if (Option.isNone(executable)) {
          return yield* new ModelDiscoveryFailed({ agent, message: `${command} was not found on PATH.` });
        }
        let models: ReadonlyArray<ModelInfo>;
        if (agent === 'claude') {
          const query = yield* Effect.try({
            try: () => sdk.query({
              prompt: Stream.toAsyncIterable(Stream.never),
              options: { cwd, pathToClaudeCodeExecutable: executable.value },
            }),
            catch: (error) => new ModelDiscoveryFailed({ agent, message: error instanceof Error ? error.message : String(error) }),
          });
          const result = yield* Effect.tryPromise({
            try: async () => {
              try { return await query.supportedModels(); }
              finally { query.close(); }
            },
            catch: (error) => new ModelDiscoveryFailed({ agent, message: error instanceof Error ? error.message : String(error) }),
          });
          const decoded = yield* Schema.decodeUnknown(ClaudeModels)(result).pipe(
            Effect.mapError((error) => new ModelDiscoveryFailed({ agent, message: error.message }))
          );
          models = decoded.map(({ value, displayName }) => ({ id: value, name: displayName }));
        } else {
          models = yield* Effect.scoped(Effect.gen(function* () {
            const process = yield* stdio.spawn({ executable: executable.value, args: agent === 'codex' ? ['app-server'] : ['acp'], cwd });
            const rpc = yield* JsonRpcConnection.open(process, {
              notification: () => Effect.void,
              request: () => Effect.succeedNone,
            });
            if (agent === 'codex') {
              yield* rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, Schema.Unknown);
              yield* rpc.notify('initialized');
              const all: ModelInfo[] = [];
              let cursor: string | null = null;
              do {
                const page: typeof CodexPage.Type = yield* rpc.request('model/list', cursor ? { cursor } : {}, CodexPage);
                all.push(...page.data.map(({ model, displayName }) => ({ id: model, name: displayName })));
                cursor = page.nextCursor;
              } while (cursor);
              return all;
            }
            yield* rpc.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              clientInfo: CLIENT_INFO,
            }, Schema.Unknown);
            const session = yield* rpc.request('session/new', { cwd, mcpServers: [] }, CursorSession);
            if (session.models?.availableModels.length) {
              return session.models.availableModels.map(({ modelId, name }) => ({ id: modelId, name }));
            }
            const options = session.configOptions?.map((value) => Schema.decodeUnknownOption(CursorModelConfig)(value)).flatMap((option) => Option.isSome(option) ? [option.value] : []);
            const config = options?.find((option) => option.category === 'model' || option.id === 'model');
            return config?.options.map(({ value, name }) => ({ id: value, name })) ?? [];
          })).pipe(Effect.mapError((error) => new ModelDiscoveryFailed({
            agent,
            message: error._tag === 'ConnectionClosed' ? error.reason : error.message,
          })));
        }
        const decoded = yield* Schema.decodeUnknown(Models)(models).pipe(
          Effect.mapError((error) => new ModelDiscoveryFailed({ agent, message: error.message }))
        );
        if (decoded.length === 0) {
          return yield* new ModelDiscoveryFailed({ agent, message: 'The agent returned no models.' });
        }
        return decoded;
      });

    return { list: (agent: AgentKind, cwd: string, executablePath: Option.Option<string>) => Effect.gen(function* () {
      let cached = cache.get(agent);
      if (!cached) {
        cached = yield* Effect.cached(discover(agent, cwd, executablePath));
        cache.set(agent, cached);
      }
      return yield* cached;
    }) };
  }));
}
