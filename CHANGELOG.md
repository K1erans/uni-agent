# Changelog

## [Unreleased]

### Added

- Claude threads: a new thread sends prompts to the user's own installed `claude` binary through
  the Claude Agent SDK and streams the reply into the tab. Uni Agent never reads or stores
  Claude credentials.
- `uniAgent.claude.executablePath` setting to use a `claude` binary that is not on `PATH`.
- Missing binary, not signed in and process crashes are shown in the thread.
- ACP-shaped normalised event model (`src/agents/events.ts`) that every adapter translates into.
- NDJSON record/replay tooling for adapter traffic, golden tests over recorded Claude fixtures,
  and an opt-in `npm run test:live` that re-records them against the real CLI.
- **Threads** native tree view in the Uni Agent activity-bar container.
- **Uni Agent: New Thread** command, opening an editor-tab webview running a React app
  (its own esbuild bundle) styled with VS Code theme variables and `@vscode-elements`.
- Activation check for `node:sqlite`, with an "update VS Code" error on older runtimes.
- Vitest (unit + webview) and `@vscode/test-cli` (extension host) test suites behind `npm test`.

### Changed

- `engines.vscode` raised to `^1.101.0`, the first release whose Node provides
  `node:sqlite` unflagged.
- `extensionKind` set to `workspace`.

### Removed

- Sidebar chat webview, `Uni Agent: Open Panel` and `Uni Agent: Run on Selection`.
- `uniAgent.apiKey` and `uniAgent.model` settings.
