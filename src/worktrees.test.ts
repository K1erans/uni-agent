import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Context, Effect, Either, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner, Worktrees, type WorktreeSettings } from './worktrees';

let root: string;
let repo: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-worktree-test-')));
  repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

/** The worktrees module over real git, with checkouts in `root/storage` unless `settings` say otherwise. */
function worktrees(settings: Partial<WorktreeSettings> = {}) {
  const layer = Worktrees.live({ storagePath: path.join(root, 'storage'), isTrusted: () => true, setupCommand: () => undefined, ...settings });
  return Effect.runSync(Effect.map(Effect.scoped(Layer.build(layer.pipe(Layer.provide(GitRunner.live)))), (context) => Context.get(context, Worktrees)));
}

const branches = (name: string) => execFileSync('git', ['branch', '--list', name], { cwd: repo }).toString().trim();

describe('Worktrees', () => {
  it('checks out a branch outside the repository, reviews its changes, and removes it keeping the branch', async () => {
    const module = worktrees();
    const worktree = await Effect.runPromise(module.create(repo, 'task-1'));
    expect(worktree).toMatchObject({ branch: 'uni/task-1', path: path.join(root, 'storage', 'task-1'), repo });

    await fs.writeFile(path.join(worktree.path, 'file.txt'), 'after\n');
    await fs.writeFile(path.join(worktree.path, 'new-file.txt'), 'delegated result\n');
    const review = await Effect.runPromise(module.review(worktree));
    expect(review.worktree).toEqual(worktree);
    expect(review.status).toContain('file.txt');
    expect(review.diffStat).toContain('file.txt');
    expect(review.diffStat).toContain('"new-file.txt" | new file');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('before\n');

    expect(await Effect.runPromise(module.exists(worktree))).toBe(true);
    await Effect.runPromise(module.remove(worktree, false));
    expect(await Effect.runPromise(module.exists(worktree))).toBe(false);
    expect(branches('uni/task-1')).toContain('uni/task-1');
  });

  it('runs the setup command for the repository, and removes the branch when asked', async () => {
    const asked: string[] = [];
    const module = worktrees({
      setupCommand: (from) => {
        asked.push(from);
        return 'echo ready > setup.txt';
      },
    });

    const worktree = await Effect.runPromise(module.create(repo, 'task-2'));

    expect(asked).toEqual([repo]);
    expect(await fs.readFile(path.join(worktree.path, 'setup.txt'), 'utf8')).toContain('ready');
    await Effect.runPromise(module.remove(worktree, true));
    expect(branches('uni/task-2')).toBe('');
  });

  it('removes the checkout and branch again when setup fails', async () => {
    const result = await Effect.runPromise(Effect.either(worktrees({ setupCommand: () => 'node -e "process.exit(7)"' }).create(repo, 'failed')));

    expect(Either.isLeft(result) && result.left._tag).toBe('WorktreeSetupFailed');
    expect(branches('uni/failed')).toBe('');
    await expect(fs.stat(path.join(root, 'storage', 'failed'))).rejects.toThrow();
  });

  it('checks nothing out in an untrusted workspace', async () => {
    const result = await Effect.runPromise(Effect.either(worktrees({ isTrusted: () => false }).create(repo, 'task-3')));

    expect(result).toEqual(Either.left(expect.objectContaining({ _tag: 'WorktreeSetupFailed', reason: 'Trust this workspace before creating a worktree thread.' })));
    expect(branches('uni/task-3')).toBe('');
  });

  it('refuses storage inside the repository', async () => {
    const result = await Effect.runPromise(Effect.either(worktrees({ storagePath: path.join(repo, '.worktrees') }).create(repo, 'task-4')));

    expect(Either.isLeft(result) && result.left.reason).toContain('outside the repository');
  });

  it('finishes a removal whose checkout is already gone, however it went', async () => {
    const module = worktrees();
    const byGit = await Effect.runPromise(module.create(repo, 'by-git'));
    const byHand = await Effect.runPromise(module.create(repo, 'by-hand'));

    // As if an earlier removal took the checkout and then failed to delete the branch.
    execFileSync('git', ['worktree', 'remove', '--force', byGit.path], { cwd: repo });
    await Effect.runPromise(module.remove(byGit, true));
    // A checkout deleted from disk, which git still lists.
    await fs.rm(byHand.path, { recursive: true, force: true });
    await Effect.runPromise(module.remove(byHand, true));
    // Nothing left to do is not a failure either.
    await Effect.runPromise(module.remove(byGit, true));

    expect(branches('uni/*')).toBe('');
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo }).toString()).not.toContain(path.join(root, 'storage'));
  });
});
