# Uni Agent

A VS Code extension that wraps existing coding-agent harnesses — Claude Code, Codex
(app-server) and Cursor (ACP) — behind one chat UI. Each thread is locked to one agent
for its lifetime; the model can change within that agent.

## Status

**Uni Agent: New Thread** opens a chat tab that talks to Claude Code: type a prompt and
the reply streams in. Codex and Cursor, tool calls, persistence and the agent picker are
still to come.

Uni Agent never stores credentials and discovers models from each agent at runtime, so
there are no API-key or model settings.

## Requirements

- **VS Code 1.101 or later.** Uni Agent uses `node:sqlite`, which VS Code's bundled Node
  only provides unflagged from 1.101 (Electron 35, Node 22.15); 1.100 ships Node 20.
  On an older runtime the extension shows an "update VS Code" error instead of activating.
- **Claude Code** installed and signed in. Uni Agent runs your own, unmodified `claude`
  binary (found on `PATH`, or set `uniAgent.claude.executablePath`) and never reads,
  stores or proxies Claude credentials: sign in by running `claude` in a terminal.
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
| Activation, `node:sqlite` check, command registration | `src/extension.ts`, `src/nodeSqlite.ts` |
| Threads tree view (native, activity bar) | `src/threadsTreeDataProvider.ts` |
| Thread editor tab (webview host, CSP) | `src/threadPanel.ts` |
| Webview ↔ extension message types | `src/protocol.ts` |
| Thread: one adapter, its event history, replayed to the webview on load | `src/thread.ts` |
| Normalised, ACP-shaped event model and adapter interface | `src/agents/events.ts`, `src/agents/adapter.ts` |
| Claude adapter (Claude Agent SDK over the user's `claude` binary) | `src/agents/claude/` |
| NDJSON traffic record/replay | `src/agents/traffic.ts`, `src/agents/claude/claudeTraffic.ts` |
| Thread chat UI (React + `@vscode-elements`) | `webview/src/` |
| Output-channel logging | `src/logger.ts` |
| Bundling (extension + webview) | `esbuild.js` |

### Commands

- **Uni Agent: New Thread** — opens a new thread in an editor tab (also the `+` on the
  Threads view).

### Settings

- `uniAgent.claude.executablePath` — path to `claude`; empty means search `PATH`.
- `uniAgent.verboseLogging` — verbose output-channel logging (includes Claude Code's stderr).

## Scripts

- `npm run compile` — type-check and bundle to `dist/` (`extension.js`, `webview/main.{js,css}`)
- `npm run watch` — rebuild on change (tsc + esbuild in parallel)
- `npm run package` — production bundle
- `npm run lint` — ESLint over `src/` and `webview/`
- `npm test` — runs both test suites:
  - `npm run test:unit` — Vitest: unit tests (`src/**/*.test.ts`, Node) and webview tests
    (`webview/**/*.test.tsx`, jsdom)
  - `npm run test:host` — `@vscode/test-cli`: extension-host tests (`src/test/`), run
    against VS Code 1.101.0 (the minimum supported version, see `.vscode-test.mjs`)
- `npm run test:live` — opt-in, never part of `npm test`: drives your installed agent CLIs
  and re-records the golden fixtures (it sends real prompts on your account)

## Testing adapters

Adapters are tested by replaying recorded traffic instead of running the real CLIs:

- A fixture (`src/agents/<agent>/fixtures/*.ndjson`) holds raw adapter traffic, one JSON
  line each: `send` (what the adapter sent), `recv` (what the agent sent back) or `exit`
  (the process died). `TrafficRecorder` writes them; `replayTraffic` plays one back as a
  fake agent, failing if the adapter sends something the fixture did not record.
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
