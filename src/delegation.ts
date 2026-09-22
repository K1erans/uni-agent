import { Effect, type Scope } from 'effect';
import { TurnInProgress, type AgentAdapter, type MakeAdapter, type ModeChangeFailed, type UnknownPermissionRequest } from './agents/adapter';
import { DEFAULT_MODE, type AgentEvent, type AgentKind, type Mode, type StopReason } from './agents/events';

/** One agent session owned by a caller's scope, independent of VS Code or MCP. */
export interface Delegation {
  readonly agent: AgentKind;
  /** Runs one turn and returns the events and final reply for review. */
  run(prompt: string): Effect.Effect<DelegationResult, TurnInProgress>;
  cancel(): Effect.Effect<void>;
  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest>;
  setMode(mode: Mode): Effect.Effect<void, ModeChangeFailed>;
}

export interface DelegationResult {
  readonly agent: AgentKind;
  readonly model: string | undefined;
  readonly sessionId: string | undefined;
  readonly stopReason: StopReason;
  readonly response: string;
  readonly events: ReadonlyArray<AgentEvent>;
}

/**
 * Builds a session from any agent adapter. The caller provides its dependencies and event sink,
 * then owns its lifetime with an Effect scope. A future MCP server and the VS Code extension can
 * use the same interface; neither transport is part of this module.
 */
export function makeDelegation<R>(
  makeAdapter: MakeAdapter<R>,
  model?: string,
  mode: Mode = DEFAULT_MODE,
  onEvent: (event: AgentEvent) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<Delegation, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    let sessionId: string | undefined;
    let configuredModel: string | undefined;
    let activeEvents: AgentEvent[] | undefined;
    let running = false;
    const adapter: AgentAdapter = yield* makeAdapter(
      (event) => Effect.zipRight(Effect.sync(() => {
        if (event.type === 'session_started') {
          sessionId = event.sessionId;
        } else if (event.type === 'session_configured') {
          configuredModel = event.model;
        }
        activeEvents?.push(event);
      }), onEvent(event)),
      mode,
      model
    );
    return {
      agent: adapter.agent,
      run: (prompt: string) =>
        Effect.suspend(() => {
          if (running) {
            return new TurnInProgress({ agent: adapter.agent });
          }
          running = true;
          const turnEvents: AgentEvent[] = [];
          activeEvents = turnEvents;
          return Effect.map(adapter.prompt([{ type: 'text', text: prompt }]), (stopReason): DelegationResult => ({
            agent: adapter.agent,
            model: configuredModel,
            sessionId,
            stopReason,
            response: replyText(turnEvents),
            events: turnEvents,
          })).pipe(Effect.ensuring(Effect.sync(() => {
            activeEvents = undefined;
            running = false;
          })));
        }),
      cancel: () => adapter.cancel(),
      respond: (requestId: string, optionId: string) => adapter.respond(requestId, optionId),
      setMode: (next: Mode) => adapter.setMode(next),
    };
  });
}

/** Groups streamed chunks by native message ID, preserving their first-seen order. */
function replyText(events: ReadonlyArray<AgentEvent>): string {
  const messages = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'session_update' && event.update.sessionUpdate === 'agent_message_chunk') {
      const { messageId, content } = event.update;
      messages.set(messageId, (messages.get(messageId) ?? '') + content.text);
    }
  }
  return [...messages.values()].join('\n');
}
