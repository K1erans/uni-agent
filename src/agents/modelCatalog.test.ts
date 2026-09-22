import { Effect, Layer, Option } from 'effect';
import type { ModelInfo as ClaudeModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { notify, request, result } from '../testing/stdioFixtures';
import { replayStdio } from './stdioTraffic';
import { replayQuery } from './claude/claudeTraffic';
import { ClaudeSdk } from './claude/claudeAdapter';
import { Executables } from './findExecutable';
import { CLIENT_INFO } from './jsonRpcAdapter';
import { ModelCatalog } from './modelCatalog';
import { Stdio } from './stdio';

function catalogWith(traffic: Parameters<typeof replayStdio>[0], claudeModels: ClaudeModelInfo[] = []) {
  let claudeCalls = 0;
  let executableCalls = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ClaudeSdk, { query: (params) => {
      claudeCalls++;
      return { ...replayQuery([])(params), supportedModels: async () => claudeModels };
    } }),
    Layer.succeed(Stdio, replayStdio(traffic)),
    Layer.succeed(Executables, { find: (name, override) => Effect.sync(() => {
      executableCalls++;
      return Option.some(Option.getOrElse(override, () => `/usr/local/bin/${name}`));
    }) }),
  );
  return {
    layer: ModelCatalog.live.pipe(Layer.provide(dependencies)),
    counts: () => ({ claudeCalls, executableCalls }),
  };
}

describe('ModelCatalog', () => {
  it('decodes Claude models and caches discovery per agent', async () => {
    const setup = catalogWith([], [{ value: 'sonnet', displayName: 'Sonnet', description: 'Fast' }]);
    const found = await Effect.runPromise(Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      const first = yield* catalog.list('claude', '/workspace', Option.none());
      const second = yield* catalog.list('claude', '/another', Option.none());
      return [first, second];
    }).pipe(Effect.provide(setup.layer)));
    expect(found).toEqual([[{ id: 'sonnet', name: 'Sonnet' }], [{ id: 'sonnet', name: 'Sonnet' }]]);
    expect(setup.counts()).toEqual({ claudeCalls: 1, executableCalls: 1 });
  });

  it('paginates and decodes Codex model/list', async () => {
    const setup = catalogWith([[
      request(1, 'initialize', { clientInfo: CLIENT_INFO, capabilities: null }), result(1, {}), notify('initialized'),
      request(2, 'model/list', {}), result(2, { data: [{ model: 'one', displayName: 'One' }], nextCursor: 'next' }),
      request(3, 'model/list', { cursor: 'next' }), result(3, { data: [{ model: 'two', displayName: 'Two' }], nextCursor: null }),
    ]]);
    const models = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* ModelCatalog).list('codex', '/workspace', Option.some('/custom/codex'));
    }).pipe(Effect.provide(setup.layer)));
    expect(models).toEqual([{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]);
  });

  it('reports malformed Cursor models as a typed discovery failure', async () => {
    const setup = catalogWith([[
      request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      }), result(1, {}),
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
      result(2, { models: { availableModels: [{ modelId: 7, name: 'Bad' }] } }),
    ]]);
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      return yield* Effect.either((yield* ModelCatalog).list('cursor', '/workspace', Option.none()));
    }).pipe(Effect.provide(setup.layer)));
    expect(outcome._tag).toBe('Left');
    if (outcome._tag === 'Left') {
      expect(outcome.left._tag).toBe('ModelDiscoveryFailed');
      expect(outcome.left.agent).toBe('cursor');
    }
  });
});
