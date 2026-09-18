import * as os from 'node:os';
import { Effect, Exit, Layer, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import type { MakeAdapter } from './agents/adapter';
import { ClaudeAdapter, ClaudeSdk } from './agents/claude/claudeAdapter';
import { Executables } from './agents/findExecutable';
import type { UniAgentApi } from './api';
import { disposable } from './disposable';
import { Ids } from './ids';
import { outputChannelLogger } from './logger';
import { MIN_VSCODE_VERSION, nodeSqliteAvailable } from './nodeSqlite';
import { readSetting } from './settings';
import { openThreadPanel } from './threadPanel';
import { ThreadsTreeDataProvider } from './threadsTreeDataProvider';

/**
 * Everything the extension acquires lives in one scope, closed when VS Code disposes the
 * extension's subscriptions: open threads first (stopping their agent processes), then commands,
 * views and the output channel.
 */
export function activate(context: vscode.ExtensionContext): UniAgentApi | undefined {
  const scope = Effect.runSync(Scope.make());
  context.subscriptions.push({ dispose: () => void Effect.runPromise(Scope.close(scope, Exit.void)) });
  return Effect.runSync(start(context.extensionUri).pipe(Scope.extend(scope)));
}

function start(extensionUri: vscode.Uri): Effect.Effect<UniAgentApi | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    const channel = yield* disposable(() => vscode.window.createOutputChannel('Uni Agent', { log: true }));
    const runtime = yield* Layer.toRuntime(Layer.mergeAll(outputChannelLogger(channel), ClaudeSdk.live, Executables.live, Ids.live));
    return yield* startServices(extensionUri).pipe(Effect.provide(runtime));
  });
}

function startServices(extensionUri: vscode.Uri): Effect.Effect<UniAgentApi | undefined, never, Services | Scope.Scope> {
  return Effect.gen(function* () {
    if (!(yield* nodeSqliteAvailable())) {
      const message =
        `Uni Agent needs VS Code ${MIN_VSCODE_VERSION} or later (its Node runtime lacks node:sqlite). ` +
        'Please update VS Code.';
      yield* Effect.logError(`node:sqlite unavailable in Node ${process.versions.node}`);
      void vscode.window.showErrorMessage(message);
      // Keep contributed commands answering with the same explanation instead of "command not found".
      yield* disposable(() => vscode.commands.registerCommand('uniAgent.newThread', () => vscode.window.showErrorMessage(message)));
      return undefined;
    }

    yield* Effect.logInfo('Uni Agent activated');

    const scope = yield* Effect.scope;
    const run = Runtime.runFork(yield* Effect.runtime<Services>());
    const threadWebviewReady = yield* disposable(() => new vscode.EventEmitter<vscode.WebviewPanel>());
    yield* disposable(() => vscode.window.registerTreeDataProvider(ThreadsTreeDataProvider.viewId, new ThreadsTreeDataProvider()));
    yield* disposable(() =>
      vscode.commands.registerCommand('uniAgent.newThread', () => {
        run(openThreadPanel(extensionUri, makeClaudeAdapter, (panel) => threadWebviewReady.fire(panel)).pipe(Scope.extend(scope)));
      })
    );

    return { onDidThreadWebviewReady: threadWebviewReady.event };
  });
}

type Services = ClaudeSdk | Executables | Ids;

/** Every thread talks to Claude until the agent picker lands. */
const makeClaudeAdapter: MakeAdapter<Services> = (onEvent) =>
  ClaudeAdapter.make({
    // Multi-root folder choice arrives with persistence; until then use the first folder.
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
    executablePath: readSetting('claude.executablePath', Schema.NonEmptyString),
    onEvent,
  });

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
