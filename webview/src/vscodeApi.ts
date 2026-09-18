import type { WebviewMessage } from '../../src/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The webview's handle to the extension. `acquireVsCodeApi` may only be called once per page. */
export const vscode = acquireVsCodeApi();
