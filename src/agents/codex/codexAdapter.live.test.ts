import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { redactUnreadNotifications } from '../stdioTraffic';
import type { WireMessage } from '../traffic';
import { recordFixture } from '../../testing/stdioFixtures';
import { CODEX_NOTIFICATIONS, CodexAdapter } from './codexAdapter';

/**
 * Drives the installed `codex` binary and re-records the golden fixtures that
 * codexAdapter.golden.test.ts replays. Run with `npm run test:live`, then `vitest -u` to refresh
 * the expected events, and review both diffs.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

const AccountResult = Schema.Struct({
  id: Schema.Number,
  result: Schema.Struct({ account: Schema.NullOr(Schema.Struct({ type: Schema.String })), requiresOpenaiAuth: Schema.Boolean }),
});
const isAccountResult = Schema.is(AccountResult);
const redactNotifications = redactUnreadNotifications(CODEX_NOTIFICATIONS);

/** Keeps the account's type but not who it is, and drops notifications the adapter does not read. */
function redact(message: WireMessage): WireMessage {
  if (isAccountResult(message)) {
    const { account, requiresOpenaiAuth } = message.result;
    return { id: message.id, result: { account: account && { type: account.type }, requiresOpenaiAuth } };
  }
  return redactNotifications(message);
}

const record = (name: string, prompt: string, env?: NodeJS.ProcessEnv) =>
  recordFixture(CodexAdapter.make, path.join(FIXTURES, `${name}.ndjson`), prompt, redact, env);

describe('Codex adapter (live)', () => {
  it('records streaming text', async () => {
    const events = await record('streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.');

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_started', agent: 'codex' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'end_turn' });
  });

  it('records a signed-out Codex', async () => {
    // An empty Codex home has no sign-in, so this never reads the user's own credentials.
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-signed-out-'));
    const events = await record('not-signed-in', 'Say hello.', { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined });

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not_signed_in' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', stopReason: 'error' });
  });
});
