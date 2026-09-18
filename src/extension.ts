import * as vscode from 'vscode';
import { Logger } from './logger';
import { isNodeSqliteAvailable, MIN_VSCODE_VERSION } from './nodeSqlite';
import { openThreadPanel } from './threadPanel';
import { ThreadsTreeDataProvider } from './threadsTreeDataProvider';

/** Returned from `activate`; lets extension-host tests observe the webview lifecycle. */
export interface UniAgentApi {
  /** Fires once a thread webview's React app has mounted. */
  readonly onDidThreadWebviewReady: vscode.Event<vscode.WebviewPanel>;
}

export function activate(context: vscode.ExtensionContext): UniAgentApi | undefined {
  const logger = new Logger('Uni Agent');
  context.subscriptions.push(logger);

  if (!isNodeSqliteAvailable()) {
    const message =
      `Uni Agent needs VS Code ${MIN_VSCODE_VERSION} or later (its Node runtime lacks node:sqlite). ` +
      'Please update VS Code.';
    logger.error(`node:sqlite unavailable in Node ${process.versions.node}`);
    void vscode.window.showErrorMessage(message);
    // Keep contributed commands answering with the same explanation instead of "command not found".
    context.subscriptions.push(
      vscode.commands.registerCommand('uniAgent.newThread', () => vscode.window.showErrorMessage(message))
    );
    return undefined;
  }

  logger.info('Uni Agent activated');

  const threadWebviewReady = new vscode.EventEmitter<vscode.WebviewPanel>();
  context.subscriptions.push(
    threadWebviewReady,
    vscode.window.registerTreeDataProvider(ThreadsTreeDataProvider.viewId, new ThreadsTreeDataProvider()),
    vscode.commands.registerCommand('uniAgent.newThread', () => {
      openThreadPanel(context.extensionUri, (panel) => threadWebviewReady.fire(panel));
    })
  );

  return { onDidThreadWebviewReady: threadWebviewReady.event };
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
