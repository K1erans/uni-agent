import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { UniAgentApi } from '../api';

suite('Uni Agent extension', () => {
  test('New Thread reveals the sidebar webview, whose React app reports ready', async () => {
    const extension = vscode.extensions.getExtension<UniAgentApi | undefined>('uni-agent.uni-agent');
    assert.ok(extension, 'extension should be installed');
    const api = await extension.activate();
    assert.ok(api, 'extension should activate fully (node:sqlite available)');

    const ready = new Promise<vscode.WebviewView>((resolve) => {
      const subscription = api.onDidWebviewReady((view) => {
        subscription.dispose();
        resolve(view);
      });
    });
    await vscode.commands.executeCommand('uniAgent.newThread');
    const view = await withTimeout(ready, 10_000, 'sidebar webview never reported ready');

    assert.strictEqual(view.viewType, 'uniAgent.sidebar');
    assert.ok(view.visible, 'sidebar view should be visible');
  });
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
