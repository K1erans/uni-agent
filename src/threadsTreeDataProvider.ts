import * as vscode from 'vscode';

/** Backs the native **Threads** tree view. Empty until threads are persisted. */
export class ThreadsTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  static readonly viewId = 'uniAgent.threads';

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [];
  }
}
