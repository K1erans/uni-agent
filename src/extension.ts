import * as os from 'node:os';
import * as vscode from 'vscode';
import { ClaudeAdapter } from './agents/claude/claudeAdapter';
import type { UniAgentApi } from './api';
import { Logger } from './logger';
import { isNodeSqliteAvailable, MIN_VSCODE_VERSION } from './nodeSqlite';
import { Thread } from './thread';
import { openThreadPanel } from './threadPanel';
import { ThreadsTreeDataProvider } from './threadsTreeDataProvider';

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
      openThreadPanel(context.extensionUri, new Thread(createClaudeAdapter(logger)), (panel) =>
        threadWebviewReady.fire(panel)
      );
    })
  );

  return { onDidThreadWebviewReady: threadWebviewReady.event };
}

/** Every thread talks to Claude until the agent picker lands. */
function createClaudeAdapter(logger: Logger): ClaudeAdapter {
  return new ClaudeAdapter({
    // Multi-root folder choice arrives with persistence; until then use the first folder.
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
    executablePath: vscode.workspace.getConfiguration('uniAgent').get<string>('claude.executablePath'),
    log: (line) => logger.debug(line),
  });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
