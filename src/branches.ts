import { Context, type Effect, type Option, type Scope } from 'effect';

/**
 * Tracks which git branch is checked out in a folder. The live layer (`gitBranchesLive` in
 * `git.ts`) reads VS Code's built-in Git extension, so it stays out of this module and unit tests
 * can provide a fake without loading `vscode`.
 */
export class Branches extends Context.Tag('uni-agent/Branches')<
  Branches,
  {
    /**
     * Reports the branch checked out at `cwd` now and whenever it changes, until the scope closes.
     * None means not a repository, a detached HEAD, or Git unavailable.
     */
    readonly watch: (cwd: string, onChange: (branch: Option.Option<string>) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  }
>() {}
