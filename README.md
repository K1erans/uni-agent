# Uni Agent

A VS Code extension that wraps existing coding-agent harnesses — Claude Code, Codex
(app-server) and Cursor (ACP) — behind one chat UI. Each thread is locked to one agent
for its lifetime; the model can change within that agent.

## Status

The **Uni Agent** sidebar holds a chat thread with Claude Code, Codex or Cursor: type a
prompt and the reply streams in. The composer shows the model and permission mode the agent
reports, and the workspace folder and git branch the thread runs in. Threads are kept per
workspace: after a reload they come back with their history, and the next message resumes the
agent's own session.

Uni Agent never stores credentials and discovers models from each agent at runtime, so
there are no API-key or model settings.

## Requirements

- **VS Code 1.106 or later.** Uni Agent uses `node:sqlite` in VS Code's bundled Node.
  On an older runtime the extension shows an "update VS Code" error instead of activating.
- The agent CLIs you use, installed and signed in. Uni Agent runs your own, unmodified
  binaries and never reads, stores or proxies their credentials:
  - **Claude Code**: `claude` (sign in by running `claude` in a terminal);
  - **Codex**: `codex`, run as `codex app-server` (sign in with `codex login`);
  - **Cursor**: the Cursor agent CLI `agent`, run as `agent acp` (sign in with `agent login`).

  Each is found on `PATH`, or set `uniAgent.<claude|codex|cursor>.executablePath`.
- The extension runs on the **workspace** side (`extensionKind: workspace`), so in remote
  setups it runs where the agent CLIs are installed.

## Getting started

```sh
npm install
npm run watch     # or: press F5 in VS Code
```

Press <kbd>F5</kbd> to launch an Extension Development Host with Uni Agent loaded.

## What's in the box

| Piece | Where |
| --- | --- |
| Activation, `node:sqlite` check, command registration, the extension's Effect scope and runtime | `src/extension.ts`, `src/nodeSqlite.ts` |
| Effect services: agent SDK, stdio processes, executable lookup, IDs; VS Code disposables in a scope; typed settings | `src/agents/claude/claudeAdapter.ts`, `src/agents/stdio.ts`, `src/agents/findExecutable.ts`, `src/ids.ts`, `src/disposable.ts`, `src/settings.ts` |
| Sidebar webview view (host, CSP) | `src/sidebar.ts` |
| Webview ↔ extension message schemas, decoded on both sides | `src/protocol.ts` |
| Thread: one scoped adapter, its timestamped event history, replayed to the webview on load, and the record it keeps itself in | `src/thread.ts` |
| The window's threads, the only way in to one: summaries out, actions by ID, which one the sidebar shows, and its branch | `src/threads.ts` |
| The transcript fold (turns, tool calls, approvals, status), shared by the extension and the webview | `src/transcript.ts` |
| Thread storage: SQLite in workspace storage, and the compaction of events into finished items | `src/database.ts`, `src/threadStore.ts`, `src/compaction.ts` |
| Worktrees: a thread's isolated checkout, from creation to removal | `src/worktrees.ts` |
| Current git branch, from VS Code's built-in Git extension | `src/branches.ts`, `src/git.ts` |
| Normalised, ACP-shaped event model (Effect schemas) and adapter interface | `src/agents/events.ts`, `src/agents/adapter.ts` |
| The session driver every agent runs in: one turn at a time, binary lookup, approvals, mode and model changes, crashes, stopping with the scope; agents plug in a handler | `src/agents/session.ts`, `src/agents/turn.ts` |
| Claude handler (Claude Agent SDK over the user's `claude` binary) | `src/agents/claude/` |
| JSON-RPC over stdio, and the connection handlers of agents that speak it compose | `src/agents/jsonRpc.ts`, `src/agents/jsonRpcSession.ts` |
| Codex handler (`codex app-server`) and Cursor handler (ACP, `agent acp`) | `src/agents/codex/`, `src/agents/cursor/` |
| Each agent's protocol beyond one session (command, handshake, models), shared by its handler and model discovery | `src/agents/*/…Protocol.ts`, `src/agents/modelCatalog.ts` |
| NDJSON traffic record/replay | `src/agents/traffic.ts`, `src/agents/claude/claudeTraffic.ts`, `src/agents/stdioTraffic.ts` |
| Sidebar chat UI (React, VS Code theme variables) | `webview/src/` |
| Effect logger that writes to the output channel | `src/logger.ts` |
| Bundling (extension + webview) | `esbuild.js` |

### Commands

- **Uni Agent: New Thread** — shows a new thread in the sidebar (the `+` in its title bar),
  with the same agent as the shown thread (Claude Code at first). A thread nobody has
  prompted yet is reused. In a multi-root workspace it asks which folder the thread works in, as
  does the sidebar when it opens with no thread to show.
- **Uni Agent: New Thread With Agent…** — asks which agent a new thread talks to; also in
  the sidebar's `···` menu. A stand-in until the composer's agent picker lands.
- **Uni Agent: New Worktree Thread…** — creates a separate checkout and branch under the
  extension's storage, runs the configured setup command, then opens a thread there. VS Code
  must trust the workspace before this command is available.
- **Uni Agent: Review Worktree Changes**, **Open Worktree in New Window**, and
  **Remove Worktree…** — inspect, open, or remove the shown thread's checkout. Removal asks
  whether to keep or discard its branch.
- **Uni Agent: Thread History** — switches the sidebar to another thread, each listed with its
  status (running, needs approval, idle, read-only). The buttons on a thread archive or delete
  it, and the last entry lists the archived threads; picking one, or its Unarchive button, brings
  it back.
- **Uni Agent: Archive Thread**, **Delete Thread…** — archive or delete the shown thread; also
  in the sidebar's `···` menu. Archiving stops the agent and hides the thread, keeping it.
  Deleting removes Uni Agent's copy of the thread (the agent's own session files are kept);
  a worktree thread's checkout is removed with it, after the same confirmation as
  **Remove Worktree…**.
- **Uni Agent: Show Logs**, **Uni Agent: Open Settings** — also in the sidebar's `···` menu.

### Settings

- `uniAgent.claude.executablePath`, `uniAgent.codex.executablePath`,
  `uniAgent.cursor.executablePath` — path to `claude`, `codex` or `agent`; empty means
  search `PATH`. Machine-scoped, so workspace settings cannot change them.
- `uniAgent.verboseLogging` — verbose output-channel logging (includes the agents' stderr).
- `uniAgent.worktree.setupCommand` — optional workspace-scoped shell command run in a new
  worktree before its thread opens.

## Scripts

- `npm run compile` — type-check and bundle to `dist/` (`extension.js`, `webview/main.{js,css}`)
- `npm run watch` — rebuild on change (tsc + esbuild in parallel)
- `npm run package` — production bundle
- `npm run lint` — ESLint over `src/` and `webview/`, then Oxlint with the anti-slop plugin
  (`.oxlintrc.json`, `tools/oxlint/anti-slop/`)
- `npm test` — runs both test suites:
  - `npm run test:unit` — Vitest: unit tests (`src/**/*.test.ts`, Node) and webview tests
    (`webview/**/*.test.tsx`, jsdom)
  - `npm run test:host` — `@vscode/test-cli`: extension-host tests (`src/test/`), run
    against VS Code 1.106.0 (the minimum supported version, see `.vscode-test.mjs`)
- `npm run test:live` — opt-in, never part of `npm test`: drives your installed agent CLIs
  and re-records the golden fixtures (it sends real prompts on your account)

## Architecture

The extension host is built on [Effect](https://effect.website): schemas at every boundary,
scopes that own each thread and its agent process, and services provided as layers. See
[ADR 0001](docs/adr/0001-effect.md) for the conventions new code follows.

## Testing adapters

Adapters are tested by replaying recorded traffic instead of running the real CLIs:

- A fixture (`src/agents/<agent>/fixtures/*.ndjson`) holds raw adapter traffic, one JSON
  line each: `send` (what the adapter sent), `recv` (what the agent sent back) or `exit`
  (the process died). `TrafficRecorder` writes them; `replayTraffic` plays one back as a
  fake agent (an Effect `Stream`), failing if the adapter sends something the fixture did not
  record. Adapter tests provide the replay as the `ClaudeSdk` service.
- Golden tests replay each fixture and compare the normalised events with the matching
  `*.events.json` file.
- To re-record after a CLI update: `npm run test:live`, then `npx vitest run -u` to refresh
  the expected events, and review both diffs. The recorder replaces your home directory
  with `~` and strips the parts of Claude's messages that describe your own setup (tools,
  MCP servers, plugins, usage limits).

## Packaging

```sh
npx @vscode/vsce package
```
