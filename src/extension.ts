import * as os from 'node:os';
import * as path from 'node:path';
import { Effect, Exit, Layer, Option, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import type { MakeAdapter } from './agents/adapter';
import { ClaudeSdk } from './agents/claude/claudeAdapter';
import { AGENT_NAMES, AgentKind } from './agents/events';
import { makeAgentAdapter } from './agents/factory';
import { Executables } from './agents/findExecutable';
import type { ModeSettings } from './agents/modes';
import { Stdio } from './agents/stdio';
import type { UniAgentApi } from './api';
import type { Branches } from './branches';
import { disposable } from './disposable';
import { FullAutoOptIn } from './fullAutoOptIn';
import { gitBranchesLive } from './git';
import { Ids } from './ids';
import { outputChannelLogger } from './logger';
import { MIN_VSCODE_VERSION, nodeSqliteAvailable } from './nodeSqlite';
import { modeSettingsLive, readSetting } from './settings';
import { registerSidebar, SIDEBAR_VIEW_ID } from './sidebar';
import type { Thread, Workspace } from './thread';
import { makeThreads, type Threads } from './threads';
import { GitRunner, WorktreeSetupFailed, type GitFailed } from './worktrees';

const COMMANDS = [
  'uniAgent.newThread',
  'uniAgent.newThreadWithAgent',
  'uniAgent.newWorktreeThread',
  'uniAgent.reviewWorktree',
  'uniAgent.openWorktree',
  'uniAgent.removeWorktree',
  'uniAgent.showThreadHistory',
  'uniAgent.showLogs',
  'uniAgent.openSettings',
] as const;

/**
 * Everything the extension acquires lives in one scope, closed when VS Code disposes the
 * extension's subscriptions: threads first (stopping their agent processes), then the sidebar,
 * commands and the output channel.
 */
export function activate(context: vscode.ExtensionContext): UniAgentApi | undefined {
  const scope = Effect.runSync(Scope.make());
  context.subscriptions.push({ dispose: () => void Effect.runPromise(Scope.close(scope, Exit.void)) });
  return Effect.runSync(start(context).pipe(Scope.extend(scope)));
}

function start(context: vscode.ExtensionContext): Effect.Effect<UniAgentApi | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    const channel = yield* disposable(() => vscode.window.createOutputChannel('Uni Agent', { log: true }));
    const runtime = yield* Layer.toRuntime(
      Layer.mergeAll(
        outputChannelLogger(channel),
        ClaudeSdk.live,
        Stdio.live,
        Executables.live,
        Ids.live,
        gitBranchesLive,
        GitRunner.live,
        modeSettingsLive,
        FullAutoOptIn.live(context.workspaceState)
      )
    );
    return yield* startServices(context.extensionUri, context.globalStorageUri.fsPath, channel).pipe(Effect.provide(runtime));
  });
}

function startServices(
  extensionUri: vscode.Uri,
  storagePath: string,
  channel: vscode.LogOutputChannel
): Effect.Effect<UniAgentApi | undefined, never, Services | Scope.Scope> {
  return Effect.gen(function* () {
    if (!(yield* nodeSqliteAvailable())) {
      const message =
        `Uni Agent needs VS Code ${MIN_VSCODE_VERSION} or later (its Node runtime lacks node:sqlite). ` +
        'Please update VS Code.';
      yield* Effect.logError(`node:sqlite unavailable in Node ${process.versions.node}`);
      void vscode.window.showErrorMessage(message);
      // Keep contributed commands answering with the same explanation instead of "command not found".
      for (const command of COMMANDS) {
        yield* disposable(() => vscode.commands.registerCommand(command, () => vscode.window.showErrorMessage(message)));
      }
      return undefined;
    }

    yield* Effect.logInfo('Uni Agent activated');

    const run = Runtime.runFork(yield* Effect.runtime<never>());
    // The sidebar shows one thread at a time, so its badge counts the others waiting for an answer.
    let sidebar: vscode.WebviewView | undefined;
    // VS Code disposes the view whenever the sidebar is hidden, and a disposed one refuses a badge.
    const showWaiting = (): Effect.Effect<void> => Effect.ignore(Effect.try(() => badgeWaiting(sidebar, threads)));
    const threads: Threads = yield* makeThreads(currentWorkspace, makeAdapter, showWaiting, {
      storagePath: path.join(storagePath, 'worktrees'),
      // Workspace settings may come from the repository. Never execute one while VS Code
      // considers that workspace untrusted, even if a caller bypasses the command picker.
      setupCommand: (where) => vscode.workspace.isTrusted
        ? Option.getOrUndefined(readSetting('worktree.setupCommand', Schema.NonEmptyString, vscode.Uri.file(where.cwd)))
        : undefined,
    });
    const webviewReady = yield* disposable(() => new vscode.EventEmitter<vscode.WebviewView>());
    yield* registerSidebar(extensionUri, threads, (view) => {
      sidebar = view;
      badgeWaiting(view, threads);
      webviewReady.fire(view);
    });

    const commands = {
      'uniAgent.newThread': () => run(Effect.zipRight(threads.create(), revealSidebar)),
      'uniAgent.newThreadWithAgent': () => run(pickAgent(threads)),
      'uniAgent.newWorktreeThread': () => run(showWorktreeError(pickAgent(threads, true))),
      'uniAgent.reviewWorktree': () => run(showWorktreeError(reviewWorktree(threads, channel))),
      'uniAgent.openWorktree': () => run(showWorktreeError(openWorktree(threads))),
      'uniAgent.removeWorktree': () => run(showWorktreeError(removeShownWorktree(threads))),
      'uniAgent.showThreadHistory': () => run(pickThread(threads)),
      'uniAgent.showLogs': () => channel.show(),
      'uniAgent.openSettings': () => void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:uni-agent.uni-agent'),
    } satisfies Record<(typeof COMMANDS)[number], () => void>;
    for (const command of COMMANDS) {
      yield* disposable(() => vscode.commands.registerCommand(command, commands[command]));
    }

    return { onDidWebviewReady: webviewReady.event };
  });
}

type Services = ClaudeSdk | Stdio | Executables | Ids | Branches | ModeSettings | FullAutoOptIn | GitRunner;

const revealSidebar = Effect.promise(async () => vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`));

/** Counts the threads waiting for the user to answer a permission request on the sidebar's icon. */
function badgeWaiting(view: vscode.WebviewView | undefined, threads: Threads): void {
  if (!view) {
    return;
  }
  const waiting = threads.list().filter((thread) => thread.needsApproval).length;
  view.badge = waiting === 0 ? undefined : { value: waiting, tooltip: waiting === 1 ? '1 thread needs approval' : `${waiting} threads need approval` };
}

/** Lets the user switch the sidebar to another of this window's threads. */
function pickThread(threads: Threads): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = threads.current;
    const items = threads.list().map((thread) => ({
      label: thread.title ?? 'New thread',
      description: threadNote(thread, thread === current),
      detail: `${AGENT_NAMES[thread.info.agent]} · ${thread.workspace.name ?? 'No folder open'}`,
      threadId: thread.info.id,
    }));
    const picked = yield* Effect.promise(async () =>
      vscode.window.showQuickPick(items, { title: 'Thread History', placeHolder: 'Switch to a thread in this window' })
    );
    if (picked) {
      yield* threads.select(picked.threadId);
      yield* revealSidebar;
    }
  });
}

/** What the thread list says about a thread beyond its title: whether it is waiting, and whether it is shown. */
function threadNote(thread: Thread, current: boolean): string | undefined {
  const notes = [...(thread.needsApproval ? ['$(shield) Needs approval'] : []), ...(current ? ['Current'] : [])];
  return notes.length > 0 ? notes.join(' · ') : undefined;
}

/** Starts a thread with the agent the user picks; a stand-in until the agent picker lands. */
function pickAgent(threads: Threads, isolated = false): Effect.Effect<void, GitFailed | WorktreeSetupFailed> {
  return Effect.gen(function* () {
    if (isolated && !vscode.workspace.isTrusted) {
      return yield* new WorktreeSetupFailed({ reason: 'Trust this workspace before creating a worktree thread.' });
    }
    const shown = threads.current?.info.agent;
    const items = AgentKind.literals.map((agent) => ({
      label: AGENT_NAMES[agent],
      description: agent === shown ? 'Current' : undefined,
      agent,
    }));
    const picked = yield* Effect.promise(async () =>
      vscode.window.showQuickPick(items, { title: isolated ? 'New Worktree Thread' : 'New Thread With Agent', placeHolder: 'Choose the agent the new thread talks to' })
    );
    if (picked) {
      yield* (isolated ? threads.createInWorktree(picked.agent) : threads.create(picked.agent));
      yield* revealSidebar;
    }
  });
}

function showWorktreeError<A>(effect: Effect.Effect<A, GitFailed | WorktreeSetupFailed>): Effect.Effect<A | void> {
  return Effect.catchAll(effect, (error) => Effect.sync(() => {
    void vscode.window.showErrorMessage(`Worktree operation failed: ${error.reason}`);
  }));
}

function reviewWorktree(threads: Threads, channel: vscode.LogOutputChannel) {
  return Effect.flatMap(threads.reviewCurrentWorktree(), (review) => Effect.sync(() => {
    if (!review) {
      void vscode.window.showInformationMessage('The shown thread uses the shared workspace.');
      return;
    }
    channel.appendLine(`Worktree ${review.worktree.path} (${review.worktree.branch})`);
    channel.appendLine(review.status || 'No changes');
    channel.appendLine(review.diffStat || 'No diff');
    channel.show();
  }));
}

function openWorktree(threads: Threads) {
  return Effect.flatMap(threads.reviewCurrentWorktree(), (review) => Effect.promise(async () => {
    if (review) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(review.worktree.path), true);
    } else {
      await vscode.window.showInformationMessage('The shown thread uses the shared workspace.');
    }
  }));
}

function removeShownWorktree(threads: Threads) {
  return Effect.gen(function* () {
    const review = yield* threads.reviewCurrentWorktree();
    if (!review) {
      yield* Effect.promise(async () => vscode.window.showInformationMessage('The shown thread uses the shared workspace.'));
      return;
    }
    const answer = yield* Effect.promise(async () => vscode.window.showWarningMessage(
      `Remove worktree ${review.worktree.branch}?`,
      { modal: true, detail: review.status ? `Uncommitted changes will be deleted:\n${review.status}` : 'The checkout will be removed.' },
      'Remove, Keep Branch', 'Discard Branch'
    ));
    if (answer) {
      yield* threads.removeCurrentWorktree(answer === 'Discard Branch');
    }
  });
}

/** Multi-root folder choice arrives with persistence; until then threads run in the first folder. */
function currentWorkspace(): Workspace {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? { cwd: folder.uri.fsPath, name: folder.name } : { cwd: os.homedir(), name: null };
}

/** Each agent's CLI is found through its own machine-scoped `uniAgent.<agent>.executablePath` setting. */
function makeAdapter(agent: AgentKind, workspace: Workspace): MakeAdapter<Services> {
  return (onEvent, mode, model) =>
    makeAgentAdapter(agent, { cwd: workspace.cwd, executablePath: readSetting(`${agent}.executablePath`, Schema.NonEmptyString), mode, model, onEvent });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
