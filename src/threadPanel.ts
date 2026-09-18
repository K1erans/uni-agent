import * as crypto from 'node:crypto';
import { Effect, ExecutionStrategy, Exit, Option, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import type { MakeAdapter } from './agents/adapter';
import { disposable } from './disposable';
import { WebviewMessage, type ExtensionMessage } from './protocol';
import { makeThread } from './thread';

export const THREAD_VIEW_TYPE = 'uniAgent.thread';

const decodeWebviewMessage = Schema.decodeUnknownOption(WebviewMessage);

/**
 * Opens a new thread in an editor-tab webview running the React app from `dist/webview`. The
 * thread gets its own scope inside the caller's: closing the tab closes it, and so does closing
 * the caller's scope (the extension deactivating), which also closes the tab.
 */
export function openThreadPanel<R>(
  extensionUri: vscode.Uri,
  makeAdapter: MakeAdapter<R>,
  onReady: (panel: vscode.WebviewPanel) => void
): Effect.Effect<vscode.WebviewPanel, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.flatMap(Effect.scope, (parent) => Scope.fork(parent, ExecutionStrategy.sequential));
    const run = Runtime.runFork(yield* Effect.runtime<never>());
    const thread = yield* makeThread(makeAdapter).pipe(Scope.extend(scope));

    const webviewRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const panel = yield* disposable(() =>
      vscode.window.createWebviewPanel(THREAD_VIEW_TYPE, 'New Thread', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [webviewRoot],
      })
    ).pipe(Scope.extend(scope));
    const post = (message: ExtensionMessage) => Effect.sync(() => void panel.webview.postMessage(message));

    yield* disposable(() =>
      panel.webview.onDidReceiveMessage((raw) =>
        run(
          Option.match(decodeWebviewMessage(raw), {
            onNone: () => Effect.logWarning('Ignored a malformed message from the thread webview'),
            onSome: (message) =>
              message.type === 'ready'
                ? Effect.andThen(thread.attach(post), () => onReady(panel))
                : thread.handle(message),
          })
        )
      )
    ).pipe(Scope.extend(scope));
    panel.onDidDispose(() => run(Scope.close(scope, Exit.void)));
    panel.webview.html = renderHtml(panel.webview, webviewRoot);
    return panel;
  });
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
