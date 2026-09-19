import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { WireMessage } from '../traffic';
import { recordFixture } from '../../testing/stdioFixtures';
import { CursorAdapter } from './cursorAdapter';

/**
 * Drives the installed Cursor agent CLI and re-records the golden fixtures that
 * cursorAdapter.golden.test.ts replays. Run with `npm run test:live`, then `vitest -u` to refresh
 * the expected events, and review both diffs.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

const Notification = Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) });
const ChunkUpdate = Schema.Struct({
  method: Schema.Literal('session/update'),
  params: Schema.Struct({ update: Schema.Struct({ sessionUpdate: Schema.Literal('agent_message_chunk', 'agent_thought_chunk') }) }),
});
const SessionUpdate = Schema.Struct({
  method: Schema.Literal('session/update'),
  params: Schema.Struct({ sessionId: Schema.String, update: Schema.Struct({ sessionUpdate: Schema.String }) }),
});

/**
 * Keeps message chunks whole but only the kind of other updates and notifications, which list the
 * user's own commands and setup.
 */
function redact(message: WireMessage): WireMessage {
  if (!Schema.is(Notification)(message) || Schema.is(ChunkUpdate)(message)) {
    return message;
  }
  if (Schema.is(SessionUpdate)(message)) {
    const { sessionId, update } = message.params;
    return { jsonrpc: '2.0', method: message.method, params: { sessionId, update: { sessionUpdate: update.sessionUpdate } } };
  }
  return { jsonrpc: '2.0', method: message.method };
}

const record = (name: string, prompt: string, env?: NodeJS.ProcessEnv) =>
  recordFixture(CursorAdapter.make, path.join(FIXTURES, `${name}.ndjson`), prompt, redact, env);

describe('Cursor adapter (live)', () => {
  it('records streaming text', async () => {
    const events = await record('streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.');

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_started', agent: 'cursor' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });
  });

  it('records a signed-out Cursor', async () => {
    // An empty home directory has no sign-in, so this never reads the user's own credentials.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-signed-out-'));
    const events = await record('not-signed-in', 'Say hello.', { ...process.env, HOME: home, CURSOR_API_KEY: undefined });

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not_signed_in' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'error' });
  });
});
