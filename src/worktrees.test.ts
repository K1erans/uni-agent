import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { createWorktree, GitRunner, inspectWorktree, prepareWorktree, removeWorktree } from './worktrees';

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

      await fs.writeFile(path.join(worktree.path, 'file.txt'), 'before\n');
      await fs.writeFile(path.join(worktree.path, 'new-file.txt'), 'delegated result\n');
      const withNewFile = await Effect.runPromise(inspectWorktree(worktree).pipe(Effect.provide(GitRunner.live)));
      expect(withNewFile.status).toContain('new-file.txt');
      expect(withNewFile.diffStat).toContain('new-file.txt');
      expect(withNewFile.diffStat).toContain('new file');

      await Effect.runPromise(removeWorktree(worktree, false).pipe(Effect.provide(GitRunner.live)));
      expect(execFileSync('git', ['branch', '--list', 'uni/task-1'], { cwd: repo }).toString()).toContain('uni/task-1');
      const prepared = await Effect.runPromise(prepareWorktree(repo, storage, 'task-2', 'echo ready > setup.txt').pipe(Effect.provide(GitRunner.live)));
      expect(await fs.readFile(path.join(prepared.path, 'setup.txt'), 'utf8')).toContain('ready');
      await Effect.runPromise(removeWorktree(prepared, true).pipe(Effect.provide(GitRunner.live)));
      expect(execFileSync('git', ['branch', '--list', 'uni/task-2'], { cwd: repo }).toString().trim()).toBe('');
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

  it('removes a checkout and branch after setup fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-agent-worktree-test-'));
    const repo = path.join(root, 'repo');
    try {
      await fs.mkdir(repo);
      execFileSync('git', ['init', '-q', repo]);
      await fs.writeFile(path.join(repo, 'file.txt'), 'before\n');
      execFileSync('git', ['add', 'file.txt'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
      const result = await Effect.runPromise(Effect.either(prepareWorktree(repo, path.join(root, 'storage'), 'failed', 'node -e "process.exit(7)"')
        .pipe(Effect.provide(GitRunner.live))));
      expect(Either.isLeft(result) && result.left._tag).toBe('WorktreeSetupFailed');
      expect(execFileSync('git', ['branch', '--list', 'uni/failed'], { cwd: repo }).toString().trim()).toBe('');
      await expect(fs.stat(path.join(root, 'storage', 'failed'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
