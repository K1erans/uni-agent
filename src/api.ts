import type * as vscode from 'vscode';

/** Returned from `activate`; lets extension-host tests observe the webview lifecycle. */
export interface UniAgentApi {
  /** Fires each time the sidebar webview's React app has mounted and been sent its thread. */
  readonly onDidWebviewReady: vscode.Event<vscode.WebviewView>;
}
