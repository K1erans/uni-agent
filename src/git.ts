import { Effect, Layer, Option, Runtime, Schema } from 'effect';
import * as vscode from 'vscode';
import { Branches } from './branches';
import { disposable } from './disposable';

/** The parts of the built-in Git extension's API (`extensions/git/src/api/git.d.ts`, v1) used here. */
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

interface GitApi {
  getRepository(uri: vscode.Uri): Repository | null;
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
  readonly state: {
    readonly HEAD: { readonly name?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
}

const decodeBranch = Schema.decodeUnknownOption(Schema.NonEmptyString);

/**
 * VS Code's Git API, or none when the Git extension is missing or disabled (`git.enabled`, or a
 * restricted-mode workspace). Worktree operations use git separately through GitRunner.
 */
const gitApi: Effect.Effect<Option.Option<GitApi>> = Effect.gen(function* () {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return Option.none();
  }
  const git = extension.isActive ? extension.exports : yield* Effect.tryPromise(async () => extension.activate());
  return git.enabled ? Option.some(git.getAPI(1)) : Option.none();
}).pipe(
  Effect.catchAll((error) => Effect.as(Effect.logWarning('Could not read the Git extension', error), Option.none()))
);

/** Follows the repository containing the folder, including one Git discovers later. */
export const gitBranchesLive = Layer.succeed(Branches, {
  watch: (cwd, onChange) =>
    Effect.gen(function* () {
      const api = yield* gitApi;
      if (Option.isNone(api)) {
        return yield* onChange(Option.none());
      }
      const git = api.value;
      const run = Runtime.runFork(yield* Effect.runtime<never>());
      const uri = vscode.Uri.file(cwd);
      let repository: Repository | null = null;
      let stateChanges: vscode.Disposable | undefined;
      // Null once reported with no branch; undefined before the first report.
      let reported: string | null | undefined;

      const report = () => {
        const next = git.getRepository(uri);
        if (next !== repository) {
          stateChanges?.dispose();
          repository = next;
          stateChanges = next?.state.onDidChange(report);
        }
        const branch = decodeBranch(repository?.state.HEAD?.name);
        if (Option.getOrNull(branch) !== reported) {
          reported = Option.getOrNull(branch);
          run(onChange(branch));
        }
      };

      yield* Effect.addFinalizer(() => Effect.sync(() => stateChanges?.dispose()));
      yield* disposable(() => git.onDidOpenRepository(report));
      yield* disposable(() => git.onDidCloseRepository(report));
      yield* Effect.sync(report);
    }),
});
