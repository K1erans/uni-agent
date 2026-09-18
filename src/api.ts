import type * as vscode from 'vscode';

/** Returned from `activate`; lets extension-host tests observe the webview lifecycle. */
export interface UniAgentApi {
  /** Fires once a thread webview's React app has mounted. */
  readonly onDidThreadWebviewReady: vscode.Event<vscode.WebviewPanel>;
}
