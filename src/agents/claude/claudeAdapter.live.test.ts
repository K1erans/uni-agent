import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events';
import { readTraffic, TrafficRecorder } from '../traffic';
import { ClaudeAdapter, type ClaudeQueryFn } from './claudeAdapter';
import { recordingQuery } from './claudeTraffic';

/**
 * Drives the installed `claude` binary and re-records the golden fixtures that
 * claudeAdapter.golden.test.ts replays. Run with `npm run test:live`, then `vitest -u` to refresh
 * the expected events, and review both diffs.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

async function record(name: string, prompt: string, queryFn: ClaudeQueryFn = query): Promise<AgentEvent[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-live-'));
  const fixture = path.join(FIXTURES, `${name}.ndjson`);
  const adapter = new ClaudeAdapter({ cwd, query: recordingQuery(queryFn, new TrafficRecorder(fixture)) });
  const events: AgentEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  adapter.start();
  await adapter.prompt([{ type: 'text', text: prompt }]);
  adapter.dispose();

  // Claude must adopt the session ID the adapter generated rather than assign its own.
  const sessionIds = new Set(readTraffic(fixture).flatMap((line) => (line.dir === 'recv' ? [(line.data as { session_id?: string }).session_id] : [])));
  expect([...sessionIds]).toEqual([adapter.sessionId]);
  return events;
}

describe('Claude adapter (live)', () => {
  it('records streaming text', async () => {
    const events = await record('streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.');

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
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
