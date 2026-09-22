import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { createWorktree, GitRunner, inspectWorktree } from './worktrees';

describe('worktree isolation', () => {
  it('creates a checkout outside the repo and reports delegated edits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-worktree-test-'));
    const repo = path.join(root, 'repo');
    const storage = path.join(root, 'storage');
    try {
      await fs.mkdir(repo);
      execFileSync('git', ['init', '-q', repo]);
      await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
      execFileSync('git', ['add', 'file.txt'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });

      const worktree = await Effect.runPromise(createWorktree(repo, storage, 'task-1').pipe(Effect.provide(GitRunner.live)));
      expect(worktree.branch).toBe('uni/task-1');
      expect(worktree.path).toBe(path.join(await fs.realpath(root), 'storage', 'task-1'));
      await fs.writeFile(path.join(worktree.path, 'file.txt'), 'after\n');
      const review = await Effect.runPromise(inspectWorktree(worktree).pipe(Effect.provide(GitRunner.live)));
      expect(review.status).toContain('file.txt');
      expect(review.diffStat).toContain('file.txt');
      expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('before\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects storage inside the source repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-worktree-test-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      const result = await Effect.runPromise(Effect.either(createWorktree(root, path.join(root, '.worktrees'), 'task-1').pipe(Effect.provide(GitRunner.live))));
      expect(Either.isLeft(result) && result.left.reason).toContain('outside the repository');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
