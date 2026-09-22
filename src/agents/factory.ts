import { Effect, type Scope } from 'effect';
import type { AdapterOptions, AgentAdapter } from './adapter';
import { ClaudeAdapter, type ClaudeSdk } from './claude/claudeAdapter';
import { CodexAdapter } from './codex/codexAdapter';
import { CursorAdapter } from './cursor/cursorAdapter';
import type { AgentKind } from './events';
import type { Executables } from './findExecutable';
import type { ModeSettings } from './modes';
import type { Stdio } from './stdio';
import type { Ids } from '../ids';

export type AgentServices = ClaudeSdk | Stdio | Executables | Ids | ModeSettings;

/** Builds the selected native agent session for the VS Code extension or a test. */
export function makeAgentAdapter(agent: AgentKind, options: AdapterOptions): Effect.Effect<AgentAdapter, never, AgentServices | Scope.Scope> {
  switch (agent) {
    case 'claude':
      return ClaudeAdapter.make(options);
    case 'codex':
      return CodexAdapter.make(options);
    case 'cursor':
      return CursorAdapter.make(options);
  }
}
