import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Context, Data, Effect, Layer } from 'effect';

const exec = promisify(execFile);

export class GitFailed extends Data.TaggedError('GitFailed')<{ readonly operation: string; readonly reason: string }> {}

export interface Git {
  run(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitFailed>;
}

export class GitRunner extends Context.Tag('uni-agent/GitRunner')<GitRunner, Git>() {
  static readonly live = Layer.succeed(GitRunner, {
    run: (cwd, args) => Effect.tryPromise({
      try: async () => (await exec('git', [...args], { cwd })).stdout.trimEnd(),
      catch: (error) => new GitFailed({ operation: args.join(' '), reason: error instanceof Error ? error.message : String(error) }),
    }),
  });
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly base: string;
}

/** Creates an isolated checkout on a new branch; the caller owns its eventual removal. */
export function createWorktree(repoPath: string, storagePath: string, slug: string): Effect.Effect<Worktree, GitFailed, GitRunner> {
  return Effect.gen(function* () {
    const git = yield* GitRunner;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      return yield* new GitFailed({ operation: 'worktree add', reason: 'Worktree slug must be lowercase letters, numbers, or hyphens.' });
    }
    const root = (yield* git.run(repoPath, ['rev-parse', '--show-toplevel'])).trim();
    const target = yield* Effect.tryPromise({
      try: () => canonicalPath(path.resolve(storagePath, slug)),
      catch: (error) => new GitFailed({ operation: 'resolve worktree storage', reason: error instanceof Error ? error.message : String(error) }),
    });
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      return yield* new GitFailed({ operation: 'worktree add', reason: 'Worktree storage must be outside the repository.' });
    }
    const base = (yield* git.run(root, ['rev-parse', 'HEAD'])).trim();
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(target), { recursive: true }),
      catch: (error) => new GitFailed({ operation: 'create worktree storage', reason: error instanceof Error ? error.message : String(error) }),
    });
    const branch = `uni/${slug}`;
    yield* git.run(root, ['worktree', 'add', '-b', branch, target, base]);
    return { path: target, branch, base };
  });
}

/** Resolves symlinked ancestors (such as macOS /var) even when the target does not exist yet. */
async function canonicalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Reports tracked changes against the starting commit and lists new files in the diff summary. */
export function inspectWorktree(worktree: Worktree): Effect.Effect<{ readonly status: string; readonly diffStat: string }, GitFailed, GitRunner> {
  return Effect.gen(function* () {
    const git = yield* GitRunner;
    const status = yield* git.run(worktree.path, ['status', '--short']);
    const trackedStat = yield* git.run(worktree.path, ['diff', '--stat', worktree.base]);
    const untracked = (yield* git.run(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter((file) => file.length > 0);
    const newFiles = untracked.map((file) => `${JSON.stringify(file)} | new file`).join('\n');
    const diffStat = [trackedStat, newFiles].filter((part) => part.length > 0).join('\n');
    return { status, diffStat };
  });
}
