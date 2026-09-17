import * as vscode from 'vscode';
import { AgentViewProvider } from './agentViewProvider';
import { Logger } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger('Uni Agent');
  context.subscriptions.push(logger);
  logger.info('Uni Agent activated');

  const provider = new AgentViewProvider(context.extensionUri, logger);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, provider),

    vscode.commands.registerCommand('uniAgent.openPanel', async () => {
      await vscode.commands.executeCommand('uniAgent.chat.focus');
    }),

    vscode.commands.registerCommand('uniAgent.run', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Uni Agent: open a file first.');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        void vscode.window.showWarningMessage('Uni Agent: select some text first.');
        return;
      }

      await vscode.commands.executeCommand('uniAgent.chat.focus');
      provider.sendPrompt(selection, {
        file: vscode.workspace.asRelativePath(editor.document.uri),
        languageId: editor.document.languageId,
      });
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
