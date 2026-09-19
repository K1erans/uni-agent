# Changelog

## [Unreleased]

### Added

- Uni Agent sidebar (a webview view in the activity-bar container) after the Paper design:
  thread heading with the agent's status and workspace; right-aligned prompts, collapsible
  thinking with the turn's duration, replies and inline error cards; Copy and Retry; and a
  composer pinned below the conversation (Enter sends, Shift+Enter adds a line) showing the
  model and permission mode Claude reports, and the workspace folder and git branch. Pickers
  for those are disabled until they can change anything. Dark themes use the Paper palette;
  light and high-contrast themes use VS Code's theme colours. Fits sidebars from 300px.
- **Uni Agent: Thread History**, **Show Logs** and **Open Settings** commands, in the sidebar's
  title bar next to **New Thread**. Threads keep running while the sidebar is hidden and are
  replayed when it reopens or switches back to them.
- `session_configured` agent event, carrying the model and permission mode from Claude's
  `system/init` message.
- Claude threads: a new thread sends prompts to the user's own installed `claude` binary through
  the Claude Agent SDK and streams the reply into the thread. Uni Agent never reads or stores
  Claude credentials.
- `uniAgent.claude.executablePath` setting to use a `claude` binary that is not on `PATH`.
- Missing binary, not signed in and process crashes are shown in the thread.
- ACP-shaped normalised event model (`src/agents/events.ts`) that every adapter translates into.
- NDJSON record/replay tooling for adapter traffic, golden tests over recorded Claude fixtures,
  and an opt-in `npm run test:live` that re-records them against the real CLI.
- **Uni Agent: New Thread** command and a React webview app (its own esbuild bundle).
- Activation check for `node:sqlite`, with an "update VS Code" error on older runtimes.
- Vitest (unit + webview) and `@vscode/test-cli` (extension host) test suites behind `npm test`.
- Effect runtime for the extension host ([ADR 0001](docs/adr/0001-effect.md)): each thread and its
  agent process live in a scope, so deactivating the extension stops every agent.
- Webview and extension decode each other's messages with Effect schemas and ignore malformed ones.
- Oxlint with the anti-slop plugin, run by `npm run lint` after ESLint.

### Changed

- `engines.vscode` raised to `^1.101.0`, the first release whose Node provides
  `node:sqlite` unflagged.
- `extensionKind` set to `workspace`.

### Removed

- The previous sidebar chat webview (superseded by the sidebar above), `Uni Agent: Open Panel`
  and `Uni Agent: Run on Selection`.
- `uniAgent.apiKey` and `uniAgent.model` settings.
