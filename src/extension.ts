import * as os from 'node:os';
import { Effect, Exit, Layer, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import type { AdapterOptions, AgentAdapter, MakeAdapter } from './agents/adapter';
import { ClaudeAdapter, ClaudeSdk } from './agents/claude/claudeAdapter';
import { CodexAdapter } from './agents/codex/codexAdapter';
import { CursorAdapter } from './agents/cursor/cursorAdapter';
import { AGENT_NAMES, AgentKind } from './agents/events';
import { Executables } from './agents/findExecutable';
import { Stdio } from './agents/stdio';
import type { UniAgentApi } from './api';
import type { Branches } from './branches';
import { disposable } from './disposable';
import { gitBranchesLive } from './git';
import { Ids } from './ids';
import { outputChannelLogger } from './logger';
import { MIN_VSCODE_VERSION, nodeSqliteAvailable } from './nodeSqlite';
import { readSetting } from './settings';
import { registerSidebar, SIDEBAR_VIEW_ID } from './sidebar';
import type { Workspace } from './thread';
import { makeThreads, type Threads } from './threads';

const COMMANDS = [
  'uniAgent.newThread',
  'uniAgent.newThreadWithAgent',
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
  return Effect.runSync(start(context.extensionUri).pipe(Scope.extend(scope)));
}

function start(extensionUri: vscode.Uri): Effect.Effect<UniAgentApi | undefined, never, Scope.Scope> {
  return Effect.gen(function* () {
    const channel = yield* disposable(() => vscode.window.createOutputChannel('Uni Agent', { log: true }));
    const runtime = yield* Layer.toRuntime(
      Layer.mergeAll(outputChannelLogger(channel), ClaudeSdk.live, Stdio.live, Executables.live, Ids.live, gitBranchesLive)
    );
    return yield* startServices(extensionUri, channel).pipe(Effect.provide(runtime));
  });
}

function startServices(
  extensionUri: vscode.Uri,
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
    const threads = yield* makeThreads(currentWorkspace, makeAdapter);
    const webviewReady = yield* disposable(() => new vscode.EventEmitter<vscode.WebviewView>());
    yield* registerSidebar(extensionUri, threads, (view) => webviewReady.fire(view));

    const commands = {
      'uniAgent.newThread': () => run(Effect.zipRight(threads.create(), revealSidebar)),
      'uniAgent.newThreadWithAgent': () => run(pickAgent(threads)),
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

type Services = ClaudeSdk | Stdio | Executables | Ids | Branches;

const revealSidebar = Effect.promise(async () => vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`));

/** Lets the user switch the sidebar to another of this window's threads. */
function pickThread(threads: Threads): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = threads.current;
    const items = threads.list().map((thread) => ({
      label: thread.title ?? 'New thread',
      description: thread === current ? 'Current' : undefined,
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

/** Starts a thread with the agent the user picks; a stand-in until the agent picker lands. */
function pickAgent(threads: Threads): Effect.Effect<void> {
  return Effect.gen(function* () {
    const shown = threads.current?.info.agent;
    const items = AgentKind.literals.map((agent) => ({
      label: AGENT_NAMES[agent],
      description: agent === shown ? 'Current' : undefined,
      agent,
    }));
    const picked = yield* Effect.promise(async () =>
      vscode.window.showQuickPick(items, { title: 'New Thread With Agent', placeHolder: 'Choose the agent the new thread talks to' })
    );
    if (picked) {
      yield* threads.create(picked.agent);
      yield* revealSidebar;
    }
  });
}

/** Multi-root folder choice arrives with persistence; until then threads run in the first folder. */
function currentWorkspace(): Workspace {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? { cwd: folder.uri.fsPath, name: folder.name } : { cwd: os.homedir(), name: null };
}

const ADAPTERS = {
  claude: ClaudeAdapter.make,
  codex: CodexAdapter.make,
  cursor: CursorAdapter.make,
} satisfies Record<AgentKind, (options: AdapterOptions) => Effect.Effect<AgentAdapter, never, Services | Scope.Scope>>;

/** Each agent's CLI is found through its own machine-scoped `uniAgent.<agent>.executablePath` setting. */
function makeAdapter(agent: AgentKind, workspace: Workspace): MakeAdapter<Services> {
  return (onEvent) =>
    ADAPTERS[agent]({ cwd: workspace.cwd, executablePath: readSetting(`${agent}.executablePath`, Schema.NonEmptyString), onEvent });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
