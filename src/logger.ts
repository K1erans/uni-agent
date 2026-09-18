import * as vscode from 'vscode';

/** Output-channel logger that respects the `uniAgent.verboseLogging` setting. */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  info(message: string): void {
    this.channel.info(message);
  }

  debug(message: string): void {
    const verbose = vscode.workspace.getConfiguration('uniAgent').get<boolean>('verboseLogging');
    if (verbose) {
      this.channel.debug(message);
    }
  }

  error(message: string, err?: unknown): void {
    this.channel.error(err ? `${message}: ${String(err)}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
