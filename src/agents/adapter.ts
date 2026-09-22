import { Data, Option, type Effect, type Scope } from 'effect';
import { AGENT_NAMES, type AgentEvent, type AgentKind, type ContentBlock, type Mode, type StopReason } from './events';

/**
 * Drives one native agent session and translates its traffic into {@link AgentEvent}s. A thread
 * owns exactly one adapter for its lifetime. Adapters never fail for agent failures: they emit an
 * `error` event instead, so every failure reaches the thread.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;

  /** Runs one prompt turn; succeeds with why the turn ended. */
  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason, TurnInProgress>;

  /** Asks the agent to stop the running turn, which then ends as `cancelled`. Pending permission requests are cancelled. */
  cancel(): Effect.Effect<void>;

  /** Answers an open permission request with the option the user chose. */
  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest>;

  /**
   * Switches the session to `mode`, mapped onto the agent's own settings. It applies to the running
   * session as soon as the agent allows, and at the latest from the next turn. If the running agent
   * refuses the switch, the adapter keeps its previous mode and fails.
   */
  setMode(mode: Mode): Effect.Effect<void, ModeChangeFailed>;
}

/** Receives every event an adapter emits, in order. */
export type EventSink = (event: AgentEvent) => Effect.Effect<void>;

/**
 * Builds an adapter for a new session. Before returning, the adapter checks the agent can run and
 * reports through the sink if it cannot. Closing the scope stops the agent process and ends a
 * running turn as `cancelled`.
 */
export type MakeAdapter<R> = (onEvent: EventSink, mode: Mode) => Effect.Effect<AgentAdapter, never, R | Scope.Scope>;

/** What every adapter is built with. */
export interface AdapterOptions {
  /** The thread's working directory. */
  readonly cwd: string;
  /** The agent's `uniAgent.<agent>.executablePath` setting; none means search PATH for its CLI. */
  readonly executablePath: Option.Option<string>;
  /** The mode the session starts in. */
  readonly mode: Mode;
  readonly onEvent: EventSink;
}

/** A prompt arrived while the session was still running a turn. */
export class TurnInProgress extends Data.TaggedError('TurnInProgress')<{ readonly agent: AgentKind }> {}

/** Explains that an agent's CLI (`command`) could not be found, naming the setting that locates it. */
export function binaryMissingMessage(agent: AgentKind, command: string, executablePath: Option.Option<string>): string {
  const name = AGENT_NAMES[agent];
  const setting = `uniAgent.${agent}.executablePath`;
  return Option.match(executablePath, {
    onSome: (path) => `${name} was not found at "${path}", the path set in ${setting}.`,
    onNone: () => `${name} ("${command}") was not found on PATH. Install ${name}, or set ${setting} to its location.`,
  });
}

/** An answer named a permission request that is not open (unknown, or already answered) or an option it does not offer. */
/** The running agent refused to switch to a mode, so it still runs in the one it had. */
export class ModeChangeFailed extends Data.TaggedError('ModeChangeFailed')<{
  readonly agent: AgentKind;
  readonly mode: Mode;
  readonly reason: string;
}> {}

export class UnknownPermissionRequest extends Data.TaggedError('UnknownPermissionRequest')<{
  readonly requestId: string;
  readonly optionId: string;
}> {}

/** Explains that an agent's CLI is not signed in; `login` is the command that signs it in. */
export function notSignedInMessage(agent: AgentKind, login: string, detail = ''): string {
  return `${AGENT_NAMES[agent]} is not signed in. Run \`${login}\` in a terminal, sign in, then try again.` + (detail ? `\n\n${detail}` : '');
}
