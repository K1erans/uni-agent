# Changelog

## [Unreleased]

### Added

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
