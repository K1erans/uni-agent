import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Chunk, Effect, Either, Exit, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { parseTraffic, readTraffic, RecordedExit, replayTraffic, TrafficRecorder, type TrafficLine, type WireMessage } from './traffic';

describe('TrafficRecorder', () => {
  it('writes NDJSON that reads back, with the home directory replaced', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uni-agent-traffic-')), 'fixture.ndjson');

    const lines = Effect.runSync(
      Effect.gen(function* () {
        const recorder = yield* TrafficRecorder.make<WireMessage, WireMessage>(file);
        yield* recorder.send({ prompt: 'hi' });
        yield* recorder.recv({ cwd: path.join(os.homedir(), 'project') });
        yield* recorder.exit('crashed');
        return yield* readTraffic(file);
      })
    );

    expect(lines).toEqual([
      { dir: 'send', data: { prompt: 'hi' } },
      { dir: 'recv', data: { cwd: path.join('~', 'project') } },
      { dir: 'exit', error: 'crashed' },
    ]);
  });
});

describe('parseTraffic', () => {
  it('rejects lines that are not traffic', () => {
    for (const line of ['{"dir":"exit","error":1}', '{"dir":"sideways","data":1}', 'not json']) {
      expect(Either.isLeft(Effect.runSync(Effect.either(parseTraffic(line))))).toBe(true);
    }
  });
});

describe('replayTraffic', () => {
  const lines = Effect.runSync(
    parseTraffic(
      [
        '{"dir":"recv","data":"hello"}',
        '{"dir":"send","data":{"n":1}}',
        '{"dir":"recv","data":"one"}',
        '{"dir":"recv","data":"uno"}',
        '{"dir":"send","data":{"n":2}}',
        '{"dir":"recv","data":"two"}',
      ].join('\n')
    )
  );

  const replay = (traffic: readonly TrafficLine[], sent: Stream.Stream<WireMessage>) =>
    Effect.runPromise(Stream.runCollect(replayTraffic(traffic, sent)).pipe(Effect.map(Chunk.toArray), Effect.either));

  it('answers each send with the replies recorded after it', async () => {
    expect(await replay(lines, Stream.make({ n: 1 }, { n: 2 }))).toEqual(Either.right(['hello', 'one', 'uno', 'two']));
  });

  it('fails when the adapter sends something the fixture did not record', async () => {
    const result = await replay(lines, Stream.make({ n: 99 }));
    expect(result).toMatchObject(Either.left({ _tag: 'FixtureMismatch', message: expect.stringContaining('does not match the fixture') }));
  });

  it('fails at an exit line, like a crashed process, after the replies before it', async () => {
    const crashing: TrafficLine[] = [{ dir: 'recv', data: 'partial' }, { dir: 'exit', error: 'exited with code 1' }];
    const replies: WireMessage[] = [];

    const exit = await Effect.runPromiseExit(
      Stream.runForEach(replayTraffic(crashing, Stream.never), (reply) => Effect.sync(() => replies.push(reply)))
    );

    expect(exit).toEqual(Exit.fail(new RecordedExit({ message: 'exited with code 1' })));
    expect(replies).toEqual(['partial']);
  });
});
