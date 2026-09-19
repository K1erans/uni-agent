import * as path from 'node:path';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { Ids } from '../../ids';
import { allowOnce, recordingSink, type Answer } from '../../testing/eventSink';
import { APPROVAL_PROMPT, TOOL_CALL_PROMPT } from '../../testing/prompts';
import type { AgentEvent } from '../events';
import { Executables } from '../findExecutable';
import { readTraffic, type TrafficLine } from '../traffic';
import { ClaudeAdapter, ClaudeSdk } from './claudeAdapter';
import { recordedSessionIds, replayQuery } from './claudeTraffic';

/**
 * Replays fixtures recorded from the real `claude` binary (see claudeAdapter.live.test.ts) and
 * asserts they produce exactly the normalised events in the matching `.events.json` file.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

async function replay(name: string, prompt: string, answer: Answer = allowOnce): Promise<AgentEvent[]> {
  const traffic = Effect.runSync(readTraffic(path.join(FIXTURES, `${name}.ndjson`)));
  const ids = [recordedSessionId(traffic), 'turn-1'];
  const events: AgentEvent[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(ClaudeSdk, { query: replayQuery(traffic) }),
    Layer.succeed(Executables, { find: () => Effect.succeed(Option.some('/usr/local/bin/claude')) }),
    Layer.succeed(Ids, { next: Effect.sync(() => ids.shift()!) })
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      let adapter: ClaudeAdapter | undefined;
      adapter = yield* ClaudeAdapter.make({
        cwd: '/workspace',
        executablePath: Option.none(),
        onEvent: recordingSink(events, answer, () => adapter),
      });
      yield* adapter.prompt([{ type: 'text', text: prompt }]);
    }).pipe(Effect.scoped, Effect.provide(services))
  );
  return events;
}

function recordedSessionId(traffic: TrafficLine[]): string {
  const sessionId = recordedSessionIds(traffic).find((id) => id !== undefined);
  if (sessionId === undefined) {
    throw new Error('fixture has no session_id');
  }
  return sessionId;
}

describe('Claude adapter golden fixtures', () => {
  it.each([
    ['streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.'],
    ['tool-call', TOOL_CALL_PROMPT],
    ['approval', APPROVAL_PROMPT],
    ['not-signed-in', 'Say hello.'],
  ])('%s', async (name, prompt) => {
    const events = await replay(name, prompt);
    await expect(JSON.stringify(events, null, 2) + '\n').toMatchFileSnapshot(`./fixtures/${name}.events.json`);
  });
});
