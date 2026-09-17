import * as vscode from 'vscode';
import { Logger } from './logger';

/** Context attached to a prompt sent from the editor. */
export interface PromptContext {
  file: string;
  languageId: string;
}

/** Messages the webview sends to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'prompt'; text: string }
  | { type: 'showLogs' };

/** Backs the Uni Agent view in the activity bar. */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'uniAgent.chat';

  private view?: vscode.WebviewView;
  private readonly pending: Array<{ text: string; context?: PromptContext }> = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((message: InboundMessage) => {
      switch (message.type) {
        case 'ready':
          this.flushPending();
          break;
        case 'prompt':
          void this.handlePrompt(message.text);
          break;
        case 'showLogs':
          this.logger.show();
          break;
      }
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Queues a prompt for the webview, focusing the view if it is not open yet. */
  sendPrompt(text: string, context?: PromptContext): void {
    this.pending.push({ text, context });
    this.flushPending();
  }

  private flushPending(): void {
    if (!this.view) {
      return;
    }
    while (this.pending.length > 0) {
      const item = this.pending.shift();
      if (item) {
        void this.view.webview.postMessage({ type: 'prompt', ...item });
      }
    }
  }

  private async handlePrompt(text: string): Promise<void> {
    this.logger.debug(`prompt: ${text}`);

    const config = vscode.workspace.getConfiguration('uniAgent');
    const model = config.get<string>('model') ?? 'claude-opus-5';

    // TODO: call the agent backend here and stream the response back.
    await this.post({
      type: 'response',
      text: `Uni Agent (${model}) is not wired to a backend yet.\n\nReceived: ${text}`,
    });
  }

  private async post(message: unknown): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage(message);
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Uni Agent</title>
  </head>
  <body>
    <div id="log" role="log" aria-live="polite"></div>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Ask Uni Agent…" aria-label="Prompt"></textarea>
      <button type="submit">Send</button>
    </form>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
