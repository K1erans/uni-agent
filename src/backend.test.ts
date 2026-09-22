import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ClaudeSdk } from './agents/claude/claudeAdapter';
import { Executables } from './agents/findExecutable';
import { CLIENT_INFO } from './agents/jsonRpcAdapter';
import { ModeSettings } from './agents/modes';
import { Stdio } from './agents/stdio';
import { replayStdio } from './agents/stdioTraffic';
import { makeBackendTask } from './backend';
import { Ids } from './ids';
import { notify, notification, request, result } from './testing/stdioFixtures';
import { GitRunner } from './worktrees';

describe('backend task', () => {
  it('runs a selected agent and model independently of the VS Code UI', async () => {
    const traffic = [
      request(1, 'initialize', { clientInfo: CLIENT_INFO, capabilities: null }),
      result(1, { userAgent: 'codex' }),
      notify('initialized'),
      request(2, 'account/read', {}),
      result(2, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
      request(3, 'thread/start', { cwd: '/workspace', model: 'gpt-6-sol' }),
      result(3, { thread: { id: 'thread-1' }, model: 'gpt-6-sol', approvalPolicy: 'on-request' }),
      request(4, 'turn/start', {
        threadId: 'thread-1', input: [{ type: 'text', text: 'Implement search', text_elements: [] }],
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      }),
      result(4, { turn: { id: 'turn-1' } }),
      notification('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Done.' }),
      notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } }),
    ];
    const observed: string[] = [];
    const services = Layer.mergeAll(
      Layer.succeed(Stdio, replayStdio([traffic])),
      Layer.succeed(Executables, { find: () => Effect.succeed(Option.some('/usr/local/bin/codex')) }),
      Layer.succeed(Ids, { next: Effect.succeed('local-turn') }),
      ModeSettings.none,
      ClaudeSdk.live,
      GitRunner.live
    );

    const output = await Effect.runPromise(Effect.gen(function* () {
      const task = yield* makeBackendTask(
        { agent: 'codex', model: 'gpt-6-sol', cwd: '/workspace' },
        (event) => Effect.sync(() => void observed.push(event.type))
      );
      return yield* task.run('Implement search');
    }).pipe(Effect.scoped, Effect.provide(services)));

    expect(output.turn).toMatchObject({
      agent: 'codex', model: 'gpt-6-sol', sessionId: 'thread-1', stopReason: 'end_turn', response: 'Done.',
    });
    expect(output.worktree).toBeUndefined();
    expect(observed).toContain('session_update');
  });
});
