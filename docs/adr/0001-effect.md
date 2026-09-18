# 0001 — Effect for the extension host and the webview protocol

**Status:** accepted, 2026-09-18

## Context

Every agent adapter manages a long-lived child process: it starts it lazily, restarts and resumes it
after a crash, interrupts turns, and has to stop it when a tab closes or the extension deactivates.
Upcoming work (queued prompts, crash recovery, worktrees, persistence) adds more concurrent,
cancellable work of the same kind.

Data also crosses several untrusted boundaries: webview messages, agent wire protocols that have
no SDK types (Codex app-server and Cursor ACP are raw JSON-RPC), settings, recorded fixtures and,
soon, SQLite rows. The anti-slop lint rules require that data to be parsed where it enters.

## Decision

Use [Effect](https://effect.website) (the `effect` package, 3.x stable) in the extension host and
for the webview protocol.

1. **Schema at every boundary.** Types that cross a boundary are defined schema-first and derived
   with `typeof X.Type` (`src/agents/events.ts`, `src/protocol.ts`). Incoming data is decoded,
   never cast: webview messages in both directions, settings (`readSetting`), fixture lines. New
   wire protocols (Codex, Cursor) and stored rows get schemas too.
2. **Scopes own lifetimes.** The extension has one scope. Each thread forks its own from it
   (`openThreadPanel`), and its adapter lives in that scope (`MakeAdapter`). Closing a tab closes
   the thread's scope, and deactivating closes them all, stopping their agent processes. VS Code
   disposables are acquired with `disposable()`, never pushed onto `context.subscriptions` one by
   one.
3. **Services and Layers for dependencies.** Anything a test needs to replace is a `Context.Tag`
   service with a `live` layer (`ClaudeSdk`, `Executables`, `Ids`). Tests provide fakes with
   `Layer.succeed` instead of passing option bags.
4. **Effect's concurrency primitives, not hand-rolled ones.** Use fibers forked into a scope
   (`Effect.forkIn`), `Queue`, `Deferred` and `Stream`. Where a library speaks `AsyncIterable`
   (the Claude Agent SDK), bridge it with `Stream.fromAsyncIterable` and `Stream.toAsyncIterable`.
5. **Typed errors for expected failures.** Use `Data.TaggedError` (for example `TurnInProgress`
   and `FixtureMismatch`). Agent failures are still reported as `error` events, so the user sees
   them in the thread.
6. **Logging through `Effect.log*`.** Logs go to the output channel (`outputChannelLogger`); debug
   lines appear only while `uniAgent.verboseLogging` is on.

Effect stops at the webview's React code (components, reducers), which stays plain React, and at
VS Code objects that must be plain classes (tree data providers, webview HTML).

## Consequences

- Closing a tab, or the extension deactivating, now reliably stops the agent process. That
  cleanup is structural rather than hand-written in each `dispose`.
- Test fakes plug in as layers, and the golden fixtures replay through the same adapter code.
- Bundles grow. The production extension bundle grew from 1.35 MB to 1.91 MB. The webview bundle
  grew from 471 KB to 796 KB (123 KB to 222 KB gzipped), mostly from Schema decoding. Both load
  from disk, not the network.
- A forked fiber starts after the effect that forked it returns. Update any state that must
  change before later events arrive before forking (see `running` in `makeThread`).
- Effect 4 is at release candidate stage. Moving to it will be a later, separate migration.
