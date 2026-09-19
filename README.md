# Uni Agent

A VS Code extension that wraps existing coding-agent harnesses — Claude Code, Codex
(app-server) and Cursor (ACP) — behind one chat UI. Each thread is locked to one agent
for its lifetime; the model can change within that agent.

## Status

The **Uni Agent** sidebar holds a chat thread with Claude Code, Codex or Cursor: type a
prompt and the reply streams in. The composer shows the model and permission mode the agent
reports, and the workspace folder and git branch the thread runs in. Tool calls, changing
the model or permissions, persistence and the agent picker in the composer are still to come.

Uni Agent never stores credentials and discovers models from each agent at runtime, so
there are no API-key or model settings.

## Requirements

- **VS Code 1.101 or later.** Uni Agent uses `node:sqlite`, which VS Code's bundled Node
  only provides unflagged from 1.101 (Electron 35, Node 22.15); 1.100 ships Node 20.
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
| Thread: one scoped adapter, its timestamped event history, replayed to the webview on load | `src/thread.ts` |
| The window's threads, which one the sidebar shows, and its branch | `src/threads.ts` |
| Current git branch, from VS Code's built-in Git extension | `src/branches.ts`, `src/git.ts` |
| Normalised, ACP-shaped event model (Effect schemas) and adapter interface | `src/agents/events.ts`, `src/agents/adapter.ts` |
| What every adapter shares: one turn at a time, binary lookup, crashes, stopping with the scope | `src/agents/baseAdapter.ts`, `src/agents/turn.ts` |
| Claude adapter (Claude Agent SDK over the user's `claude` binary) | `src/agents/claude/` |
| JSON-RPC over stdio, and the adapter base for agents that speak it | `src/agents/jsonRpc.ts`, `src/agents/jsonRpcAdapter.ts` |
| Codex adapter (`codex app-server`) and Cursor adapter (ACP, `agent acp`) | `src/agents/codex/`, `src/agents/cursor/` |
| NDJSON traffic record/replay | `src/agents/traffic.ts`, `src/agents/claude/claudeTraffic.ts`, `src/agents/stdioTraffic.ts` |
| Sidebar chat UI (React, VS Code theme variables) | `webview/src/` |
| Effect logger that writes to the output channel | `src/logger.ts` |
| Bundling (extension + webview) | `esbuild.js` |

### Commands

- **Uni Agent: New Thread** — shows a new thread in the sidebar (the `+` in its title bar),
  with the same agent as the shown thread (Claude Code at first). A thread nobody has
  prompted yet is reused.
- **Uni Agent: New Thread With Agent…** — asks which agent a new thread talks to; also in
  the sidebar's `···` menu. A stand-in until the composer's agent picker lands.
- **Uni Agent: Thread History** — switches the sidebar to another of this window's threads.
  Threads last until the window closes; they are not persisted yet.
- **Uni Agent: Show Logs**, **Uni Agent: Open Settings** — also in the sidebar's `···` menu.

### Settings

- `uniAgent.claude.executablePath`, `uniAgent.codex.executablePath`,
  `uniAgent.cursor.executablePath` — path to `claude`, `codex` or `agent`; empty means
  search `PATH`. Machine-scoped, so workspace settings cannot change them.
- `uniAgent.verboseLogging` — verbose output-channel logging (includes the agents' stderr).

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
    against VS Code 1.101.0 (the minimum supported version, see `.vscode-test.mjs`)
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
