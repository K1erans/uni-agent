import * as crypto from 'node:crypto';
import { Effect, ExecutionStrategy, Exit, Option, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import { disposable } from './disposable';
import { FullAutoOptIn } from './fullAutoOptIn';
import { WebviewMessage } from './protocol';
import type { Post } from './thread';
import type { Threads } from './threads';

/** The sidebar webview view, contributed in `package.json`. */
export const SIDEBAR_VIEW_ID = 'uniAgent.sidebar';

const decodeWebviewMessage = Schema.decodeUnknownOption(WebviewMessage);

/**
 * Hosts the React app from `dist/webview` in the Uni Agent sidebar and connects it to `threads`.
 * VS Code disposes the webview whenever the view is hidden; each time it is shown again, it
 * resolves a fresh one, which reports `ready` and is sent the current thread.
 */
export function registerSidebar(
  extensionUri: vscode.Uri,
  threads: Threads,
  onReady: (view: vscode.WebviewView) => void
): Effect.Effect<void, never, FullAutoOptIn | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const run = Runtime.runFork(yield* Effect.runtime<FullAutoOptIn>());
    const webviewRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');

    /** Wires one webview up; everything it acquires lives until VS Code disposes the view. */
    const resolve = (view: vscode.WebviewView) =>
      Effect.gen(function* () {
        const viewScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
        const post: Post = (message) => Effect.sync(() => void view.webview.postMessage(message));

        const handle = (message: WebviewMessage) => {
          switch (message.type) {
            case 'ready':
              return Effect.andThen(threads.connect(post), () => onReady(view));
            case 'prompt':
              return Effect.flatMap(threads.submitSidebar(post, message.threadId, message.text), (outcome) =>
                post({ type: 'prompt_result', threadId: message.threadId, submissionId: message.submissionId, ...outcome })
              );
            case 'permission_response':
              return threads.respond(message.threadId, message.requestId, message.optionId);
            case 'set_mode':
              return Effect.zipRight(message.mode === 'full_auto' ? confirmFullAuto : Effect.void, threads.setMode(message.threadId, message.mode));
            case 'copy':
              return Effect.tryPromise(async () => vscode.env.clipboard.writeText(message.text)).pipe(
                Effect.catchAll((error) => Effect.logWarning('Could not copy to the clipboard', error))
              );
          }
        };

        view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
        yield* disposable(() =>
          view.webview.onDidReceiveMessage((raw) =>
            run(
              Option.match(decodeWebviewMessage(raw), {
                onNone: () => Effect.logWarning('Ignored a malformed message from the sidebar webview'),
                onSome: handle,
              })
            )
          )
        ).pipe(Scope.extend(viewScope));
        yield* disposable(() =>
          view.onDidDispose(() => run(Effect.zipRight(threads.disconnect(post), Scope.close(viewScope, Exit.void))))
        ).pipe(Scope.extend(viewScope));
        view.webview.html = renderHtml(view.webview, webviewRoot);
      });

    const provider: vscode.WebviewViewProvider = { resolveWebviewView: (view) => void run(resolve(view)) };
    yield* disposable(() => vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider));
  });
}

/** Asks the user, once per workspace, to allow Full auto; `Threads` refuses it until they have. */
const confirmFullAuto = Effect.gen(function* () {
  const optIn = yield* FullAutoOptIn;
  if (yield* optIn.granted) {
    return;
  }
  const allow = 'Allow Full Auto';
  const answer = yield* Effect.promise(async () =>
    vscode.window.showWarningMessage(
      'Allow Full auto in this workspace?',
      {
        modal: true,
        detail:
          'In Full auto, agents edit files and run commands without asking first. Uni Agent remembers your choice for this workspace.',
      },
      allow
    )
  );
  if (answer === allow) {
    yield* optIn.grant;
  }
});

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
