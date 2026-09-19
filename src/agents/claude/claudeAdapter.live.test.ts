import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { Ids } from '../../ids';
import { allowOnce, recordingSink, type Answer } from '../../testing/eventSink';
import { APPROVAL_PROMPT, TOOL_CALL_PROMPT } from '../../testing/prompts';
import type { AgentEvent } from '../events';
import { Executables } from '../findExecutable';
import { readTraffic, TrafficRecorder, type WireMessage } from '../traffic';
import { ClaudeAdapter, ClaudeSdk, type ClaudeQueryFn } from './claudeAdapter';
import { recordedSessionIds, recordingQuery } from './claudeTraffic';

/**
 * Drives the installed `claude` binary and re-records the golden fixtures that
 * claudeAdapter.golden.test.ts replays. Run with `npm run test:live`, then `vitest -u` to refresh
 * the expected events, and review both diffs.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

async function record(name: string, prompt: string, queryFn: ClaudeQueryFn = query, answer: Answer = allowOnce): Promise<AgentEvent[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-live-'));
  const fixture = path.join(FIXTURES, `${name}.ndjson`);
  const events: AgentEvent[] = [];
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const recorder = yield* TrafficRecorder.make<SDKUserMessage | WireMessage, Partial<SDKMessage> | WireMessage>(fixture);
      let adapter: ClaudeAdapter | undefined;
      adapter = yield* ClaudeAdapter.make({
        cwd,
        executablePath: Option.none(),
        onEvent: recordingSink(events, answer, () => adapter),
      }).pipe(Effect.provide(Layer.succeed(ClaudeSdk, { query: recordingQuery(queryFn, recorder) })));
      yield* adapter.prompt([{ type: 'text', text: prompt }]);
      return adapter.sessionId;
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(Executables.live, Ids.live)))
  );

  // Claude must adopt the session ID the adapter generated rather than assign its own.
  const sessionIds = new Set(recordedSessionIds(Effect.runSync(readTraffic(fixture))));
  expect([...sessionIds]).toEqual([sessionId]);
  return events;
}

describe('Claude adapter (live)', () => {
  it('records streaming text', async () => {
    const events = await record('streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.');

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });
  });

  it('records a tool call Claude runs by itself', async () => {
    const events = await record('tool-call', TOOL_CALL_PROMPT);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'session_update' && event.update.sessionUpdate === 'tool_call')).not.toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });
  });

  it('records an approval round-trip', async () => {
    const events = await record('approval', APPROVAL_PROMPT);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_resolved' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });
  });

  it('records a signed-out Claude Code', async () => {
    // An empty config directory has no sign-in, so this never reads the user's own credentials.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-signed-out-'));
    const signedOut: ClaudeQueryFn = ({ prompt, options }) =>
      query({ prompt, options: { ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: undefined } } });

    const events = await record('not-signed-in', 'Say hello.', signedOut);

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not_signed_in' }));
  });
});
