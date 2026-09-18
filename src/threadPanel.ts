import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionMessage, WebviewMessage } from './protocol';
import type { Thread } from './thread';

export const THREAD_VIEW_TYPE = 'uniAgent.thread';

/**
 * Opens a thread as an editor-tab webview running the React app from `dist/webview`. The panel owns
 * the thread: closing the tab disposes it.
 */
export function openThreadPanel(
  extensionUri: vscode.Uri,
  thread: Thread,
  onReady: (panel: vscode.WebviewPanel) => void
): vscode.WebviewPanel {
  const webviewRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const panel = vscode.window.createWebviewPanel(THREAD_VIEW_TYPE, 'New Thread', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [webviewRoot],
  });
  const post = (message: ExtensionMessage) => void panel.webview.postMessage(message);
  const messages = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
    if (message.type === 'ready') {
      thread.attach(post);
      onReady(panel);
    } else {
      thread.handle(message);
    }
  });
  panel.onDidDispose(() => {
    messages.dispose();
    thread.dispose();
  });
  panel.webview.html = renderHtml(panel.webview, webviewRoot);
  return panel;
}

function renderHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.css'));
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Uni Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
