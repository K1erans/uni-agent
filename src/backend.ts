import { Effect, Option, type Scope } from 'effect';
import type { ModeChangeFailed, TurnInProgress, UnknownPermissionRequest } from './agents/adapter';
import { makeAgentAdapter, type AgentServices } from './agents/factory';
import { DEFAULT_MODE, type AgentEvent, type AgentKind, type Mode } from './agents/events';
import { makeDelegation, type DelegationResult } from './delegation';
import { createWorktree, inspectWorktree, type GitFailed, type GitRunner, type Worktree } from './worktrees';

export interface BackendTaskOptions {
  readonly agent: AgentKind;
  readonly model?: string;
  readonly mode?: Mode;
  readonly cwd: string;
  readonly executablePath?: string;
  readonly worktree?: { readonly storagePath: string; readonly slug: string };
}

export interface BackendTaskResult {
  readonly delegation: DelegationResult;
  readonly worktree: Worktree | undefined;
  readonly review: { readonly status: string; readonly diffStat: string } | undefined;
}

export interface BackendTask {
  readonly workspace: string;
  readonly worktree: Worktree | undefined;
  run(prompt: string): Effect.Effect<BackendTaskResult, TurnInProgress | GitFailed, GitRunner>;
  cancel(): Effect.Effect<void>;
  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest>;
  setMode(mode: Mode): Effect.Effect<void, ModeChangeFailed>;
}

/**
 * Creates a host-neutral task. Its owner supplies an Effect scope and services; closing the scope
 * stops the native agent. A worktree, when requested, remains available for review afterwards.
 */
export function makeBackendTask(
  options: BackendTaskOptions,
  onEvent: (event: AgentEvent) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<BackendTask, GitFailed, AgentServices | GitRunner | Scope.Scope> {
  return Effect.gen(function* () {
    const worktree = options.worktree
      ? yield* createWorktree(options.cwd, options.worktree.storagePath, options.worktree.slug)
      : undefined;
    const workspace = worktree?.path ?? options.cwd;
    const delegation = yield* makeDelegation(
      (sink, mode, model) => makeAgentAdapter(options.agent, {
        cwd: workspace,
        executablePath: Option.fromNullable(options.executablePath),
        mode,
        model,
        onEvent: sink,
      }),
      options.model,
      options.mode ?? DEFAULT_MODE,
      onEvent
    );
    return {
      workspace,
      worktree,
      run: (prompt) => Effect.gen(function* () {
        const result = yield* delegation.run(prompt);
        const review = worktree ? yield* inspectWorktree(worktree) : undefined;
        return { delegation: result, worktree, review };
      }),
      cancel: () => delegation.cancel(),
      respond: (requestId, optionId) => delegation.respond(requestId, optionId),
      setMode: (mode) => delegation.setMode(mode),
    };
  });
}
