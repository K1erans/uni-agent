import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect, Exit, Layer, Option, Scope } from 'effect';
import { Ids } from '../ids';
import type { AdapterOptions, AgentAdapter } from '../agents/adapter';
import type { AgentEvent } from '../agents/events';
import { Executables } from '../agents/findExecutable';
import { Stdio, type StdioCommand } from '../agents/stdio';
import { recordedCwd, recordingStdio, replayStdio } from '../agents/stdioTraffic';
import { readTraffic, TrafficRecorder, type TrafficLine, type WireMessage } from '../agents/traffic';
import { allowOnce, recordingSink, type Answer } from './eventSink';

/** Builds an adapter for an agent Uni Agent runs over stdio, such as `CodexAdapter.make`. */
export type MakeStdioAdapter = (options: AdapterOptions) => Effect.Effect<AgentAdapter, never, Stdio | Executables | Ids | Scope.Scope>;

/**
 * Replays a fixture recorded by {@link recordFixture} through the adapter, prompting it as the
 * recording did, and returns the normalised events it emitted. Turn IDs are `turn-1`, `turn-2`...
 */
export function replayFixture(make: MakeStdioAdapter, fixture: string, prompt: string, answer: Answer = allowOnce): Promise<AgentEvent[]> {
  const traffic = Effect.runSync(readTraffic(fixture));
  let turns = 0;
  const services = Layer.mergeAll(
    Layer.succeed(Stdio, replayStdio([traffic])),
    Layer.succeed(Executables, { find: (name) => Effect.succeed(Option.some(`/usr/local/bin/${name}`)) }),
    Layer.succeed(Ids, { next: Effect.sync(() => `turn-${++turns}`) })
  );
  return runPrompt(make, recordedCwd(traffic), prompt, services, answer);
}

/**
 * Drives the installed agent CLI through the adapter in a fresh temporary directory, recording its
 * traffic to `fixture` after `redact`. `env` replaces the environment the CLI runs with.
 */
export function recordFixture(
  make: MakeStdioAdapter,
  fixture: string,
  prompt: string,
  redact: (message: WireMessage) => WireMessage,
  env?: NodeJS.ProcessEnv,
  answer: Answer = allowOnce
): Promise<AgentEvent[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-live-'));
  const recording = Layer.effect(
    Stdio,
    Effect.gen(function* () {
      const live = yield* Stdio;
      const recorder = yield* TrafficRecorder.make<WireMessage, WireMessage>(fixture);
      return recordingStdio({ spawn: (command) => live.spawn({ ...command, env }) }, recorder, redact);
    })
  ).pipe(Layer.provide(Stdio.live));
  return runPrompt(make, cwd, prompt, Layer.mergeAll(recording, Executables.live, Ids.live), answer);
}

async function runPrompt(
  make: MakeStdioAdapter,
  cwd: string,
  prompt: string,
  services: Layer.Layer<Stdio | Executables | Ids>,
  answer: Answer
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      let adapter: AgentAdapter | undefined;
      adapter = yield* make({ cwd, executablePath: Option.none(), onEvent: recordingSink(events, answer, () => adapter) });
      yield* adapter.prompt([{ type: 'text', text: prompt }]);
    }).pipe(Effect.scoped, Effect.provide(services))
  );
  return events;
}

// Builders for hand-written JSON-RPC traffic.

export const request = (id: number, method: string, params: WireMessage): TrafficLine => ({
  dir: 'send',
  data: { jsonrpc: '2.0', id, method, params },
});
export const notify = (method: string, params?: WireMessage): TrafficLine => ({
  dir: 'send',
  data: params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params },
});
export const result = (id: number, value: WireMessage): TrafficLine => ({ dir: 'recv', data: { id, result: value } });
export const rpcError = (id: number, code: number, message: string): TrafficLine => ({ dir: 'recv', data: { id, error: { code, message } } });
export const notification = (method: string, params: WireMessage): TrafficLine => ({ dir: 'recv', data: { method, params } });
/** A request from the agent to the client. */
export const agentRequest = (id: number, method: string, params: WireMessage): TrafficLine => ({ dir: 'recv', data: { id, method, params } });
/** The client answering a request from the agent. */
export const answer = (id: number, value: WireMessage): TrafficLine => ({ dir: 'send', data: { jsonrpc: '2.0', id, result: value } });
/** The client declining an agent request it does not support. */
export const methodNotFound = (id: number, method: string): TrafficLine => ({
  dir: 'send',
  data: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
});
export const exit = (error: string): TrafficLine => ({ dir: 'exit', error });

/**
 * Builds an adapter over fake agent processes, each replaying the next of `processes`, in a scope
 * the test can close. Turn IDs are `turn-1`, `turn-2`...
 *
 * @param answer How the user answers a permission request; no answer leaves the request open.
 */
export function setupAdapter(
  make: MakeStdioAdapter,
  processes: ReadonlyArray<readonly TrafficLine[]>,
  find: (name: string) => Option.Option<string> = (name) => Option.some(`/usr/local/bin/${name}`),
  answer?: Answer
) {
  const events: AgentEvent[] = [];
  const spawned: StdioCommand[] = [];
  const replay = replayStdio(processes);
  let turns = 0;
  const services = Layer.mergeAll(
    Layer.succeed(Stdio, { spawn: (command) => Effect.zipRight(Effect.sync(() => spawned.push(command)), replay.spawn(command)) }),
    Layer.succeed(Executables, { find: (name) => Effect.sync(() => find(name)) }),
    Layer.succeed(Ids, { next: Effect.sync(() => `turn-${++turns}`) })
  );
  const scope = Effect.runSync(Scope.make());
  // The sink reaches the adapter to answer its asks, and only ever runs once it has been built.
  let built: AgentAdapter | undefined;
  built = Effect.runSync(
    make({ cwd: '/workspace', executablePath: Option.none(), onEvent: recordingSink(events, answer, () => built) }).pipe(
      Scope.extend(scope),
      Effect.provide(services)
    )
  );
  const adapter = built;
  return {
    adapter,
    events,
    spawned,
    prompt: (text: string) => Effect.runPromise(adapter.prompt([{ type: 'text', text }])),
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    errors: () => events.filter((event) => event.type === 'error'),
    /** The tool call updates in the events, as the adapter sent them. */
    toolUpdates: () =>
      events.flatMap((event) =>
        event.type === 'session_update' && (event.update.sessionUpdate === 'tool_call' || event.update.sessionUpdate === 'tool_call_update')
          ? [event.update]
          : []
      ),
    /** The text of each chunk, with its kind and message ID. */
    chunks: () =>
      events.flatMap((event) =>
        event.type === 'session_update' && (event.update.sessionUpdate === 'agent_message_chunk' || event.update.sessionUpdate === 'agent_thought_chunk')
          ? [[event.update.sessionUpdate, event.update.messageId, event.update.content.text]]
          : []
      ),
  };
}
