import { Effect, Option, type Scope } from 'effect';
import { makeAgentAdapter, type AgentServices } from './agents/factory';
import { DEFAULT_MODE, type AgentEvent, type AgentKind, type Mode } from './agents/events';
import { Ids } from './ids';
import { makeThread, type PromptRejected, type TurnResult } from './thread';
import { prepareWorktree, inspectWorktree, type GitFailed, type GitRunner, type Worktree, type WorktreeSetupFailed } from './worktrees';

export interface BackendTaskOptions {
  readonly agent: AgentKind;
  readonly model?: string;
  readonly mode?: Mode;
  readonly cwd: string;
  readonly executablePath?: string;
  readonly worktree?: { readonly storagePath: string; readonly slug: string; readonly setupCommand?: string };
}

export interface BackendTaskResult {
  readonly turn: TurnResult;
  readonly worktree: Worktree | undefined;
  readonly review: { readonly status: string; readonly diffStat: string } | undefined;
}

export interface BackendTask {
  readonly workspace: string;
  readonly worktree: Worktree | undefined;
  run(prompt: string): Effect.Effect<BackendTaskResult, PromptRejected | GitFailed, GitRunner>;
  cancel(): Effect.Effect<void>;
  respond(requestId: string, optionId: string): Effect.Effect<void>;
  setMode(mode: Mode): Effect.Effect<void>;
}

/**
 * Creates a host-neutral task. Its owner supplies an Effect scope and services; closing the scope
 * stops the native agent. A worktree, when requested, remains available for review afterwards.
 */
export function makeBackendTask(
  options: BackendTaskOptions,
  onEvent: (event: AgentEvent) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<BackendTask, GitFailed | WorktreeSetupFailed, AgentServices | GitRunner | Scope.Scope> {
  return Effect.gen(function* () {
    const worktree = options.worktree
      ? yield* prepareWorktree(options.cwd, options.worktree.storagePath, options.worktree.slug, options.worktree.setupCommand)
      : undefined;
    const workspace = worktree?.path ?? options.cwd;
    const ids = yield* Ids;
    const thread = yield* makeThread(
      yield* ids.next,
      { cwd: workspace, name: null },
      (sink, mode, model) => makeAgentAdapter(options.agent, {
        cwd: workspace,
        executablePath: Option.fromNullable(options.executablePath),
        mode,
        model,
        onEvent: sink,
      }),
      { onEvent, model: options.model, mode: options.mode ?? DEFAULT_MODE }
    );
    return {
      workspace,
      worktree,
      run: (prompt) => Effect.gen(function* () {
        const result = yield* thread.run(prompt);
        const review = worktree ? yield* inspectWorktree(worktree) : undefined;
        return { turn: result, worktree, review };
      }),
      cancel: () => thread.cancel(),
      respond: (requestId, optionId) => thread.respond(requestId, optionId),
      setMode: (mode) => thread.setMode(mode),
    };
  });
}
