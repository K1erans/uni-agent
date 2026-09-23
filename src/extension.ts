import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect, Exit, Layer, Option, Runtime, Schema, Scope } from 'effect';
import * as vscode from 'vscode';
import type { MakeAdapter } from './agents/adapter';
import { ClaudeSdk } from './agents/claude/claudeAdapter';
import { AGENT_NAMES, AgentKind } from './agents/events';
import { makeAgentAdapter } from './agents/factory';
import { ModelCatalog } from './agents/modelCatalog';
import { Executables } from './agents/findExecutable';
import type { ModeSettings } from './agents/modes';
import { Stdio } from './agents/stdio';
import type { UniAgentApi } from './api';
import type { Branches } from './branches';
import { Database, DatabaseError } from './database';
import { disposable } from './disposable';
import { FullAutoOptIn } from './fullAutoOptIn';
import { gitBranchesLive } from './git';
import { Ids } from './ids';
import { outputChannelLogger } from './logger';
import { MIN_VSCODE_VERSION, nodeSqliteAvailable } from './nodeSqlite';
import { modeSettingsLive, readSetting } from './settings';
import { registerSidebar, SIDEBAR_VIEW_ID } from './sidebar';
import type { Thread, ThreadStatus, Workspace } from './thread';
import { makeThreads, type Threads } from './threads';
import { THREAD_STORE_MIGRATIONS, ThreadStore, type StoredThread } from './threadStore';
import { GitRunner, inspectWorktree, WorktreeSetupFailed, type GitFailed, type Worktree } from './worktrees';

const COMMANDS = [
  'uniAgent.newThread',
  'uniAgent.newThreadWithAgent',
  'uniAgent.newWorktreeThread',
  'uniAgent.reviewWorktree',
  'uniAgent.openWorktree',
  'uniAgent.removeWorktree',
  'uniAgent.showThreadHistory',
  'uniAgent.archiveThread',
  'uniAgent.deleteThread',
  'uniAgent.showLogs',
  'uniAgent.openSettings',
] as const;

/**
 * Everything the extension acquires lives in one scope, closed when VS Code disposes the
 * extension's subscriptions: threads first (stopping their agent processes), then the sidebar,
 * commands, the thread database and the output channel.
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
        ModelCatalog.live.pipe(Layer.provide(Layer.mergeAll(ClaudeSdk.live, Stdio.live, Executables.live))),
        Ids.live,
        gitBranchesLive,
        GitRunner.live,
        modeSettingsLive,
        FullAutoOptIn.live(context.workspaceState)
      )
    );
    return yield* startServices(context.extensionUri, context.globalStorageUri.fsPath, context.storageUri?.fsPath, channel).pipe(Effect.provide(runtime));
  });
}

/**
 * @param storagePath The extension's global storage, where worktrees are checked out.
 * @param workspaceStoragePath This workspace's storage, where threads are kept; none when no folder is open.
 */
function startServices(
  extensionUri: vscode.Uri,
  storagePath: string,
  workspaceStoragePath: string | undefined,
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
    // Built in the extension's scope before the threads, so it closes after they have stopped.
    const store = yield* Layer.build(threadStoreLive(workspaceStoragePath));

    const run = Runtime.runFork(yield* Effect.runtime<GitRunner>());
    // The sidebar shows one thread at a time, so its badge counts the others waiting for an answer.
    let sidebar: vscode.WebviewView | undefined;
    // VS Code disposes the view whenever the sidebar is hidden, and a disposed one refuses a badge.
    const showWaiting = (): Effect.Effect<void> => Effect.ignore(Effect.try(() => badgeWaiting(sidebar, threads)));
    const threads: Threads = yield* makeThreads({ fallback: currentWorkspace, choose: pickWorkspace }, makeAdapter, showWaiting, {
      storagePath: path.join(storagePath, 'worktrees'),
      // Workspace settings may come from the repository. Never execute one while VS Code
      // considers that workspace untrusted, even if a caller bypasses the command picker.
      setupCommand: (where) => vscode.workspace.isTrusted
        ? Option.getOrUndefined(readSetting('worktree.setupCommand', Schema.NonEmptyString, vscode.Uri.file(where.cwd)))
        : undefined,
    }).pipe(Effect.provide(store));
    const webviewReady = yield* disposable(() => new vscode.EventEmitter<vscode.WebviewView>());
    yield* registerSidebar(extensionUri, threads, (view) => {
      sidebar = view;
      badgeWaiting(view, threads);
      webviewReady.fire(view);
    });

    const commands = {
      'uniAgent.newThread': () => run(newThread(threads)),
      'uniAgent.newThreadWithAgent': () => run(pickAgent(threads)),
      'uniAgent.newWorktreeThread': () => run(showWorktreeError(pickAgent(threads, true))),
      'uniAgent.reviewWorktree': () => run(showWorktreeError(reviewWorktree(threads, channel))),
      'uniAgent.openWorktree': () => run(showWorktreeError(openWorktree(threads))),
      'uniAgent.removeWorktree': () => run(showWorktreeError(removeShownWorktree(threads))),
      'uniAgent.showThreadHistory': () => run(pickThread(threads)),
      'uniAgent.archiveThread': () => run(threads.current ? threads.archive(threads.current.info.id) : Effect.void),
      'uniAgent.deleteThread': () => run(showWorktreeError(threads.current ? deleteThread(threads, threads.current.info.id, threads.current.title) : Effect.void)),
      'uniAgent.showLogs': () => channel.show(),
      'uniAgent.openSettings': () => void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:uni-agent.uni-agent'),
    } satisfies Record<(typeof COMMANDS)[number], () => void>;
    for (const command of COMMANDS) {
      yield* disposable(() => vscode.commands.registerCommand(command, commands[command]));
    }

    return { onDidWebviewReady: webviewReady.event };
  });
}

type Services = ClaudeSdk | Stdio | Executables | ModelCatalog | Ids | Branches | ModeSettings | FullAutoOptIn | GitRunner;

const revealSidebar = Effect.promise(async () => vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`));

/** Counts the threads waiting for the user to answer a permission request on the sidebar's icon. */
function badgeWaiting(view: vscode.WebviewView | undefined, threads: Threads): void {
  if (!view) {
    return;
  }
  const waiting = threads.list().filter((thread) => thread.needsApproval).length;
  view.badge = waiting === 0 ? undefined : { value: waiting, tooltip: waiting === 1 ? '1 thread needs approval' : `${waiting} threads need approval` };
}

/** An entry in Thread History: a thread in the window, an archived one, or the way to the archived ones. */
type HistoryItem = vscode.QuickPickItem & { readonly entry: { readonly kind: 'thread'; readonly thread: Thread } | { readonly kind: 'archived'; readonly thread: StoredThread } | { readonly kind: 'show_archived' } };

type HistoryChoice = { readonly action: 'open' | 'archive' | 'delete'; readonly item: HistoryItem };

const ARCHIVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('archive'), tooltip: 'Archive Thread' };
const DELETE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete Thread…' };
const UNARCHIVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Unarchive Thread' };

const STATUS_NOTES = {
  running: '$(sync~spin) Running',
  needs_approval: '$(shield) Needs approval',
  idle: 'Idle',
  read_only: '$(lock) Read-only',
} satisfies Record<ThreadStatus, string>;

/**
 * Lets the user switch the sidebar to another thread, or archive or delete one with the buttons on
 * its item. With `archivedOnly`, lists the archived threads instead; picking one, or its Unarchive
 * button, brings it back.
 * After archiving or deleting, the list opens again, so several can be tidied in a row.
 */
function pickThread(threads: Threads, archivedOnly = false): Effect.Effect<void, never, GitRunner> {
  return Effect.gen(function* () {
    const current = threads.current;
    const archived = threads.archived();
    const items: HistoryItem[] = archivedOnly
      ? archived.map((thread) => ({
          label: thread.title ?? 'New thread',
          description: thread.readOnly ? STATUS_NOTES.read_only : undefined,
          detail: `${AGENT_NAMES[thread.agent]} · ${thread.workspace.name ?? 'No folder open'}`,
          buttons: [UNARCHIVE_BUTTON, DELETE_BUTTON],
          entry: { kind: 'archived', thread },
        }))
      : [
          ...threads.list().map((thread): HistoryItem => ({
            label: thread.title ?? 'New thread',
            description: [STATUS_NOTES[thread.status], ...(thread === current ? ['Current'] : [])].join(' · '),
            detail: `${AGENT_NAMES[thread.info.agent]} · ${thread.workspace.name ?? 'No folder open'}`,
            buttons: [ARCHIVE_BUTTON, DELETE_BUTTON],
            entry: { kind: 'thread', thread },
          })),
          ...(archived.length > 0 ? [{ label: `$(archive) Archived threads (${archived.length})`, entry: { kind: 'show_archived' } } as const] : []),
        ];
    const choice = yield* choose(items, archivedOnly ? 'Archived Threads' : 'Thread History', archivedOnly ? 'Bring an archived thread back' : 'Switch to a thread in this workspace');
    if (!choice) {
      return;
    }
    const { entry } = choice.item;
    if (entry.kind === 'show_archived') {
      return yield* pickThread(threads, true);
    }
    const threadId = entry.kind === 'thread' ? entry.thread.info.id : entry.thread.id;
    if (choice.action === 'open') {
      yield* entry.kind === 'thread' ? threads.select(threadId) : threads.unarchive(threadId);
      yield* revealSidebar;
      return;
    }
    yield* choice.action === 'archive' ? threads.archive(threadId) : showWorktreeError(deleteThread(threads, threadId, entry.thread.title));
    yield* pickThread(threads, archivedOnly && threads.archived().length > 0);
  });
}

/** Shows a quick pick of `items` and waits for the user to pick one, press one of its buttons, or dismiss it. */
function choose(items: ReadonlyArray<HistoryItem>, title: string, placeholder: string): Effect.Effect<HistoryChoice | undefined> {
  return Effect.async<HistoryChoice | undefined>((resume) => {
    const pick = vscode.window.createQuickPick<HistoryItem>();
    let settled = false;
    const settle = (choice: HistoryChoice | undefined) => {
      if (!settled) {
        settled = true;
        resume(Effect.succeed(choice));
      }
      pick.hide();
    };
    pick.title = title;
    pick.placeholder = placeholder;
    pick.items = items;
    pick.onDidAccept(() => settle(pick.selectedItems[0] && { action: 'open', item: pick.selectedItems[0] }));
    // Unarchiving an archived thread is what picking it does.
    pick.onDidTriggerItemButton(({ button, item }) =>
      settle({ action: button === ARCHIVE_BUTTON ? 'archive' : button === UNARCHIVE_BUTTON ? 'open' : 'delete', item })
    );
    pick.onDidHide(() => {
      settle(undefined);
      pick.dispose();
    });
    pick.show();
    return Effect.sync(() => pick.dispose());
  });
}

/**
 * Deletes a thread once the user confirms. A worktree thread goes through the same confirmation as
 * Remove Worktree, since its checkout goes with it.
 */
function deleteThread(threads: Threads, threadId: string, title: string | undefined): Effect.Effect<void, GitFailed, GitRunner> {
  return Effect.gen(function* () {
    const worktree = threads.worktreeOf(threadId);
    if (worktree) {
      const status = yield* Effect.orElseSucceed(inspectWorktree(worktree).pipe(Effect.map(({ status }) => status)), () => '');
      const discardBranch = yield* confirmWorktreeRemoval(worktree, status);
      if (Option.isSome(discardBranch)) {
        yield* threads.remove(threadId, discardBranch.value);
      }
      return;
    }
    const remove = 'Delete';
    const answer = yield* Effect.promise(async () => vscode.window.showWarningMessage(
      `Delete “${title ?? 'New thread'}”?`,
      { modal: true, detail: 'Its history is removed from Uni Agent. The agent’s own session files are kept.' },
      remove
    ));
    if (answer === remove) {
      yield* threads.remove(threadId);
    }
  });
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
    const where = picked ? yield* pickWorkspace : Option.none();
    if (picked && Option.isSome(where)) {
      yield* (isolated ? threads.createInWorktree(picked.agent, where.value) : threads.create(picked.agent, where.value));
      yield* revealSidebar;
    }
  });
}

/** Shows a new thread, in the folder the user picks when the workspace has several. */
function newThread(threads: Threads): Effect.Effect<void> {
  return Effect.gen(function* () {
    const where = yield* pickWorkspace;
    if (Option.isSome(where)) {
      yield* threads.create(undefined, where.value);
      yield* revealSidebar;
    }
  });
}

function showWorktreeError<A, R>(effect: Effect.Effect<A, GitFailed | WorktreeSetupFailed, R>): Effect.Effect<A | void, never, R> {
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
    const discardBranch = yield* confirmWorktreeRemoval(review.worktree, review.status);
    if (Option.isSome(discardBranch)) {
      yield* threads.removeCurrentWorktree(discardBranch.value);
    }
  });
}

/**
 * Asks whether to remove a worktree thread and its checkout, which deletes the thread too.
 * Succeeds with whether to discard its branch as well, or none if the user said no.
 */
function confirmWorktreeRemoval(worktree: Worktree, status: string): Effect.Effect<Option.Option<boolean>> {
  return Effect.map(
    Effect.promise(async () => vscode.window.showWarningMessage(
      `Remove worktree ${worktree.branch}?`,
      { modal: true, detail: (status ? `Uncommitted changes will be deleted:\n${status}` : 'The checkout will be removed.') + '\n\nThe thread is deleted with it.' },
      'Remove, Keep Branch', 'Discard Branch'
    )),
    (answer) => Option.map(Option.fromNullable(answer), (chosen) => chosen === 'Discard Branch')
  );
}

/**
 * The folder a new thread works in: the only one, or the one the user picks in a multi-root
 * workspace. None if they dismiss the pick, in which case no thread is created.
 */
const pickWorkspace: Effect.Effect<Option.Option<Workspace>> = Effect.suspend(() => {
  if ((vscode.workspace.workspaceFolders?.length ?? 0) <= 1) {
    return Effect.succeed(Option.some(currentWorkspace()));
  }
  return Effect.map(
    Effect.promise(async () => vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the folder the new thread works in' })),
    (folder) => Option.map(Option.fromNullable(folder), (picked): Workspace => ({ cwd: picked.uri.fsPath, name: picked.name }))
  );
});

/**
 * Where a thread works when nobody picked a folder, such as the one the sidebar opens with: the
 * first workspace folder, or the home directory when none is open.
 */
function currentWorkspace(): Workspace {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? { cwd: folder.uri.fsPath, name: folder.name } : { cwd: os.homedir(), name: null };
}

/** Each agent's CLI is found through its own machine-scoped `uniAgent.<agent>.executablePath` setting. */
function makeAdapter(agent: AgentKind, workspace: Workspace): MakeAdapter<Services> {
  return (onEvent, mode, model, resume) =>
    makeAgentAdapter(agent, { cwd: workspace.cwd, executablePath: readSetting(`${agent}.executablePath`, Schema.NonEmptyString), mode, model, resume, onEvent });
}

/**
 * The thread store: in this workspace's storage, or in memory when no folder is open (VS Code gives
 * such a window no workspace storage) or the database cannot be opened, which is reported.
 */
function threadStoreLive(workspaceStoragePath: string | undefined): Layer.Layer<ThreadStore> {
  const inMemory = Layer.orDie(ThreadStore.memory);
  if (!workspaceStoragePath) {
    return inMemory;
  }
  const file = path.join(workspaceStoragePath, 'threads.db');
  const createFolder = Effect.tryPromise({
    try: () => fs.mkdir(workspaceStoragePath, { recursive: true }),
    catch: (error) => new DatabaseError({ operation: `create ${workspaceStoragePath}`, reason: error instanceof Error ? error.message : String(error) }),
  });
  const onDisk = ThreadStore.layer.pipe(Layer.provide(Layer.unwrapEffect(Effect.as(createFolder, Database.layer(file, THREAD_STORE_MIGRATIONS)))));
  return Layer.catchAll(onDisk, (error) =>
    Layer.unwrapEffect(
      Effect.gen(function* () {
        yield* Effect.logError(`Could not open the thread database ${file} (${error.operation}): ${error.reason}`);
        void vscode.window.showErrorMessage(`Uni Agent couldn’t open its thread database, so threads won’t be kept after this window closes. ${error.reason}`);
        return inMemory;
      })
    )
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
