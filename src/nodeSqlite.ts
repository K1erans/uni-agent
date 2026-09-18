import { Effect } from 'effect';

/**
 * Uni Agent relies on `node:sqlite`, which the Node runtime bundled with VS Code only
 * provides unflagged from VS Code 1.101 (Electron 35, Node 22.15). Keep in sync with
 * `engines.vscode` in package.json.
 */
export const MIN_VSCODE_VERSION = '1.101';

/** Whether `node:sqlite` loads; never fails. */
export function nodeSqliteAvailable(load: () => void = () => require('node:sqlite')): Effect.Effect<boolean> {
  return Effect.try(load).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  );
}
