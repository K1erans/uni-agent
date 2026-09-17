# Uni Agent

A VS Code extension that puts an agent panel in the activity bar.

## Status

Scaffold. The UI, commands, settings and build pipeline are wired up; the agent
backend is not — `AgentViewProvider.handlePrompt` currently echoes the prompt
back. That method is the single place to plug in a real model call.

## Getting started

```sh
npm install
npm run watch     # or: press F5 in VS Code
```

Press <kbd>F5</kbd> to launch an Extension Development Host with Uni Agent loaded.

## What's in the box

| Piece | Where |
| --- | --- |
| Activation + command registration | `src/extension.ts` |
| Sidebar webview (chat UI) | `src/agentViewProvider.ts`, `media/` |
| Output-channel logging | `src/logger.ts` |
| Bundling | `esbuild.js` |

### Commands

- **Uni Agent: Open Panel** — reveals the sidebar view.
- **Uni Agent: Run on Selection** — sends the editor selection to the panel
  (also on the editor context menu when text is selected).

### Settings

- `uniAgent.model` — model identifier to use.
- `uniAgent.apiKey` — API key for the backend.
- `uniAgent.verboseLogging` — verbose output-channel logging.

## Scripts

- `npm run compile` — type-check and bundle to `dist/`
- `npm run watch` — rebuild on change (tsc + esbuild in parallel)
- `npm run package` — production bundle
- `npm run lint` — ESLint over `src/`

## Packaging

```sh
npx @vscode/vsce package
```
