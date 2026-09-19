# Changelog

## [Unreleased]

### Added

- Tool calls in the thread: each one a collapsible item with its input, its output and its status
  (waiting, running, done, failed), for Claude, Codex and Cursor alike.
- Command approvals: when an agent asks permission, the thread shows an inline card on the tool
  call with the answers the agent offers, and the answer goes back through the agent's own
  mechanism — Claude's `canUseTool` callback, Codex's approval requests, ACP
  `session/request_permission`. Stopping the turn or closing the thread answers every open
  request as cancelled, so no agent is left waiting.
- A thread waiting for an answer is flagged in its heading and in **Thread History**, and the
  sidebar's icon carries a badge counting the threads waiting.
- Golden fixtures for a tool-call sequence and an approval round-trip per agent, recorded from
  the real CLIs by `npm run test:live`.

- Codex threads: `codex app-server` over JSON-RPC stdio, streaming agent messages and reasoning
  summaries through Codex's started → delta → completed item lifecycle. Signed-out Codex is
  detected up front with `account/read`.
- Cursor threads: the Cursor agent CLI as an ACP server (`agent acp`); session updates stream
  into the thread, and requests outside what Uni Agent supports (including Cursor's extension
  methods) are declined with "method not found".
- **Uni Agent: New Thread With Agent…** command, a temporary agent selector; **New Thread**
  keeps the shown thread's agent. Threads carry their agent in `ThreadInfo`.
- `uniAgent.codex.executablePath` and `uniAgent.cursor.executablePath` machine-scoped settings.
- A shared JSON-RPC-over-stdio transport (`Stdio` service, `JsonRpcConnection`) with schema
  decoding on arrival: malformed traffic ends the connection as a `process_crashed` error. A
  crashed Codex or Cursor process is restarted on the next prompt and resumes its session.
- Golden tests over recorded Codex and Cursor fixtures, re-recorded by `npm run test:live`.

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
- Agents that assign their own session IDs announce `session_started` once the first turn has
  created the session, so `AgentAdapter` no longer exposes a `sessionId`. The webview reads the
  thread's agent from `ThreadInfo`. Adapters share `BaseAdapter`.

### Removed

- The previous sidebar chat webview (superseded by the sidebar above), `Uni Agent: Open Panel`
  and `Uni Agent: Run on Selection`.
- `uniAgent.apiKey` and `uniAgent.model` settings.
