import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events';
import { readTraffic, type TrafficLine } from '../traffic';
import { ClaudeAdapter } from './claudeAdapter';
import { replayQuery } from './claudeTraffic';

/**
 * Replays fixtures recorded from the real `claude` binary (see claudeAdapter.live.test.ts) and
 * asserts they produce exactly the normalised events in the matching `.events.json` file.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

async function replay(name: string, prompt: string): Promise<AgentEvent[]> {
  const traffic = readTraffic(path.join(FIXTURES, `${name}.ndjson`));
  const ids = [recordedSessionId(traffic), 'turn-1'];
  const adapter = new ClaudeAdapter({
    cwd: '/workspace',
    query: replayQuery(traffic),
    findClaude: () => '/usr/local/bin/claude',
    newId: () => ids.shift()!,
  });
  const events: AgentEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  adapter.start();
  await adapter.prompt([{ type: 'text', text: prompt }]);
  adapter.dispose();
  return events;
}

function recordedSessionId(traffic: TrafficLine[]): string {
  for (const line of traffic) {
    if (line.dir === 'recv' && typeof (line.data as { session_id?: unknown }).session_id === 'string') {
      return (line.data as { session_id: string }).session_id;
    }
  }
  throw new Error('fixture has no session_id');
}

describe('Claude adapter golden fixtures', () => {
  it('streaming-text', async () => {
    const events = await replay('streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.');
    await expect(JSON.stringify(events, null, 2) + '\n').toMatchFileSnapshot('./fixtures/streaming-text.events.json');
  });

  it('not-signed-in', async () => {
    const events = await replay('not-signed-in', 'Say hello.');
    await expect(JSON.stringify(events, null, 2) + '\n').toMatchFileSnapshot('./fixtures/not-signed-in.events.json');
  });
});
