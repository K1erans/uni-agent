import { Effect, type Scope } from 'effect';
import type * as vscode from 'vscode';

/** Acquires a VS Code disposable in the current scope: closing the scope disposes it. */
export function disposable<A extends vscode.Disposable>(acquire: () => A): Effect.Effect<A, never, Scope.Scope> {
  return Effect.acquireRelease(Effect.sync(acquire), (resource) => Effect.sync(() => resource.dispose()));
}
