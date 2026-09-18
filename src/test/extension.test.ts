import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { UniAgentApi } from '../api';

suite('Uni Agent extension', () => {
  test('New Thread opens an editor-tab webview whose React app reports ready', async () => {
    const extension = vscode.extensions.getExtension<UniAgentApi | undefined>('uni-agent.uni-agent');
    assert.ok(extension, 'extension should be installed');
    const api = await extension.activate();
    assert.ok(api, 'extension should activate fully (node:sqlite available)');

    const ready = new Promise<vscode.WebviewPanel>((resolve) => {
      const subscription = api.onDidThreadWebviewReady((panel) => {
        subscription.dispose();
        resolve(panel);
      });
    });
    await vscode.commands.executeCommand('uniAgent.newThread');
    const panel = await withTimeout(ready, 10_000, 'thread webview never reported ready');

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputWebview, 'active editor tab should be a webview');
    assert.ok(tab.input.viewType.endsWith('uniAgent.thread'), `unexpected viewType ${tab.input.viewType}`);

    panel.dispose();
  });
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
