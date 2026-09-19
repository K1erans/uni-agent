import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayFixture } from '../../testing/stdioFixtures';
import { CursorAdapter } from './cursorAdapter';

/**
 * Replays fixtures recorded from the real cursor CLI (see cursorAdapter.live.test.ts) and asserts
 * they produce exactly the normalised events in the matching `.events.json` file.
 */
const FIXTURES = path.join(__dirname, 'fixtures');

describe('Cursor adapter golden fixtures', () => {
  it.each([
    ['streaming-text', 'Count from 1 to 5, one number per line. Reply with nothing else.'],
    ['not-signed-in', 'Say hello.'],
  ])('%s', async (name, prompt) => {
    const events = await replayFixture(CursorAdapter.make, path.join(FIXTURES, `${name}.ndjson`), prompt);
    await expect(JSON.stringify(events, null, 2) + '\n').toMatchFileSnapshot(`./fixtures/${name}.events.json`);
  });
});
