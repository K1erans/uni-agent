# Uni Agent

A VS Code extension that wraps existing coding-agent harnesses — Claude Code, Codex
(app-server) and Cursor (ACP) — behind one chat UI. Each thread is locked to one agent
for its lifetime; the model can change within that agent.

## Status

Skeleton. The **Threads** tree view and the **Uni Agent: New Thread** command are wired
up and open an empty React chat tab; no agent is connected yet.

Uni Agent never stores credentials and discovers models from each agent at runtime, so
there are no API-key or model settings.

## Requirements

- **VS Code 1.101 or later.** Uni Agent uses `node:sqlite`, which VS Code's bundled Node
  only provides unflagged from 1.101 (Electron 35, Node 22.15); 1.100 ships Node 20.
  On an older runtime the extension shows an "update VS Code" error instead of activating.
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
| Thread chat UI (React + `@vscode-elements`) | `webview/src/` |
| Output-channel logging | `src/logger.ts` |
| Bundling (extension + webview) | `esbuild.js` |

### Commands

- **Uni Agent: New Thread** — opens a new thread in an editor tab (also the `+` on the
  Threads view).

### Settings

- `uniAgent.verboseLogging` — verbose output-channel logging.

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

## Packaging

```sh
npx @vscode/vsce package
```
