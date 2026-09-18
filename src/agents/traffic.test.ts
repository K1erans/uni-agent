import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './asyncQueue';
import { parseTraffic, readTraffic, replayTraffic, TrafficRecorder, type TrafficLine } from './traffic';

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe('TrafficRecorder', () => {
  it('writes NDJSON that reads back, with the home directory replaced', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-traffic-')), 'fixture.ndjson');
    const recorder = new TrafficRecorder(file);

    recorder.send({ prompt: 'hi' });
    recorder.recv({ cwd: path.join(os.homedir(), 'project') });
    recorder.exit('crashed');

    expect(readTraffic(file)).toEqual([
      { dir: 'send', data: { prompt: 'hi' } },
      { dir: 'recv', data: { cwd: path.join('~', 'project') } },
      { dir: 'exit', error: 'crashed' },
    ]);
  });
});

describe('replayTraffic', () => {
  const lines = parseTraffic(
    [
      '{"dir":"recv","data":"hello"}',
      '{"dir":"send","data":{"n":1}}',
      '{"dir":"recv","data":"one"}',
      '{"dir":"recv","data":"uno"}',
      '{"dir":"send","data":{"n":2}}',
      '{"dir":"recv","data":"two"}',
    ].join('\n')
  );

  it('answers each send with the replies recorded after it', async () => {
    const sent = new AsyncQueue<unknown>();
    sent.push({ n: 1 });
    sent.push({ n: 2 });
    sent.close();

    expect(await collect(replayTraffic(lines, sent))).toEqual(['hello', 'one', 'uno', 'two']);
  });

  it('fails when the adapter sends something the fixture did not record', async () => {
    const sent = new AsyncQueue<unknown>();
    sent.push({ n: 99 });

    await expect(collect(replayTraffic(lines, sent))).rejects.toThrow('does not match the fixture');
  });

  it('throws at an exit line, like a crashed process', async () => {
    const crashing: TrafficLine[] = [{ dir: 'recv', data: 'partial' }, { dir: 'exit', error: 'exited with code 1' }];
    const replies: unknown[] = [];

    await expect(
      (async () => {
        for await (const reply of replayTraffic(crashing, new AsyncQueue())) {
          replies.push(reply);
        }
      })()
    ).rejects.toThrow('exited with code 1');
    expect(replies).toEqual(['partial']);
  });
});
