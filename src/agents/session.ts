import { Deferred, Effect, Option, type Schema, type Scope } from 'effect';
import { Ids } from '../ids';
import { binaryMissingMessage, ModelChangeFailed, TurnInProgress, type AdapterOptions, type AgentAdapter, type ModeChangeFailed, type UnknownPermissionRequest } from './adapter';
import { Approvals } from './approvals';
import { AGENT_NAMES, MODE_NAMES, type AgentEvent, type AgentKind, type ContentBlock, type Mode, type StopReason } from './events';
import { Executables } from './findExecutable';
import { ModeSettings, nativeMode, type ModeOverrides } from './modes';
import type { EventSink } from './adapter';
import type { Turn } from './turn';

/**
 * What an agent's handler can see and do of the session driving it. The driver owns the session's
 * state (the running turn, the mode and model the user chose, whether it has stopped); a handler
 * reads it here and changes it only through these calls.
 */
export interface AgentSession<T extends Turn> {
  readonly agent: AgentKind;
  readonly options: AdapterOptions;
  /** The session's scope; closing it stops the session. Processes a handler starts live in scopes forked from it. */
  readonly scope: Scope.Scope;
  /** The permission requests waiting for the user, shared by every turn of the session. */
  readonly approvals: Approvals;
  /** The running turn, if any. */
  turn(): T | undefined;
  /** The mode the user chose; the agent runs in it from when it starts, or as soon as it can after a change. */
  mode(): Mode;
  /** The model the user chose; undefined for the agent's default. */
  model(): string | undefined;
  /** Whether the session has stopped, so a process ending is expected rather than a crash. */
  stopped(): boolean;
  emit(event: AgentEvent): Effect.Effect<void>;
  /** Ends `turn` if it is still the running one, cancelling any permission request left open. */
  endTurn(turn: T, stopReason: StopReason): Effect.Effect<void>;
  /** Reports that the agent process stopped unexpectedly, ending the running turn as `error`. */
  crashed(reason: string): Effect.Effect<void>;
  /**
   * The agent's native settings for the current mode: the user's override for it, if the agent's
   * `modeOverrides` setting names one no looser than the built-in setting, otherwise `builtIn`'s.
   */
  native<A, I>(builtIn: (mode: Mode) => A, overrides: Schema.Schema<ModeOverrides<A>, I>, noLooser: (override: A, builtIn: A) => boolean): Effect.Effect<A>;
}

/**
 * What an agent brings to a session: how to start it and speak its protocol. The driver calls these
 * one turn at a time and never while the session is stopping, except `stop` itself.
 */
export interface AgentHandler<T extends Turn> {
  /** The agent CLI's name on PATH. */
  readonly command: string;
  /** Makes a turn of this agent's kind, emitting through `emit`. */
  newTurn(id: string, ended: Deferred.Deferred<StopReason>, emit: EventSink): T;
  /** Starts the agent if it is not running and sends it the prompt. The turn ends through `AgentSession.endTurn`. */
  runTurn(turn: T, executable: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void>;
  /** Asks the agent to stop the running turn; `turn.cancelRequested` is already set. */
  interrupt(turn: T): Effect.Effect<void>;
  /** Stops the agent process, if one is running, without reporting it. */
  stop(): Effect.Effect<void>;
  /** Applies the session's mode to the running agent, if any; an agent that starts later starts in it. */
  applyMode(): Effect.Effect<void, ModeChangeFailed>;
  /** Applies a model to an already open session; unopened sessions use the chosen model when they start. */
  applyModel(model: string | undefined): Effect.Effect<void, ModelChangeFailed>;
}

/**
 * Drives one native agent session: one turn at a time, finding the agent's CLI, answering its
 * permission requests, switching its mode and model (rolling back what the agent refuses), and
 * ending the running turn as `cancelled` when the scope closes. The agent itself is `build`'s
 * handler, which is given the session's controls; the handler's `stop` runs when the scope closes,
 * and a missing CLI is reported as soon as the session is made.
 */
export function makeAgentSession<T extends Turn, H extends AgentHandler<T>, R>(
  agent: AgentKind,
  options: AdapterOptions,
  build: (session: AgentSession<T>) => Effect.Effect<H, never, R>
): Effect.Effect<AgentAdapter & { readonly handler: H }, never, R | Executables | Ids | ModeSettings | Scope.Scope> {
  return Effect.gen(function* () {
    const executables = yield* Executables;
    const ids = yield* Ids;
    const modeSettings = yield* ModeSettings;
    const scope = yield* Effect.scope;
    const approvals = new Approvals(options.onEvent);
    let turn: T | undefined;
    let mode = options.mode;
    let model = options.model;
    let stopped = false;
    // One mode change at a time: a refused change restores the mode it replaced, which is only
    // right if no other change has landed since.
    const modeLock = yield* Effect.makeSemaphore(1);

    const endTurn = (ending: T, stopReason: StopReason) =>
      Effect.suspend(() => {
        if (turn !== ending) {
          return Effect.void;
        }
        turn = undefined;
        // Nothing answers a request once its turn is over, so none is left waiting.
        return Effect.zipRight(approvals.cancelAll(), ending.end(stopReason));
      });

    const session: AgentSession<T> = {
      agent,
      options,
      scope,
      approvals,
      turn: () => turn,
      mode: () => mode,
      model: () => model,
      stopped: () => stopped,
      emit: (event) => options.onEvent(event),
      endTurn,
      crashed: (reason) =>
        Effect.gen(function* () {
          yield* Effect.logDebug(`${AGENT_NAMES[agent]} stopped: ${reason}`);
          const running = turn;
          yield* options.onEvent({ type: 'error', turnId: running?.id, code: 'process_crashed', message: `${AGENT_NAMES[agent]} stopped unexpectedly: ${reason}` });
          if (running) {
            yield* endTurn(running, 'error');
          }
        }),
      native: (builtIn, overrides, noLooser) =>
        Effect.gen(function* () {
          const { native, ignored } = nativeMode(mode, builtIn, yield* modeSettings.overrides(agent, overrides), noLooser);
          if (Option.isSome(ignored)) {
            yield* Effect.logWarning(`Ignored the ${AGENT_NAMES[agent]} override for ${MODE_NAMES[mode]}, which would allow more than the mode does`, ignored.value);
          }
          return native;
        }),
    };

    const handler = yield* build(session);
    const findExecutable = executables.find(handler.command, options.executablePath);
    const reportBinaryMissing = (turnId?: string) =>
      options.onEvent({ type: 'error', turnId, code: 'binary_missing', message: binaryMissingMessage(agent, handler.command, options.executablePath) });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopped = true;
        yield* approvals.cancelAll();
        yield* handler.stop();
        if (turn) {
          yield* endTurn(turn, 'cancelled');
        }
      })
    );
    if (Option.isNone(yield* findExecutable)) {
      yield* reportBinaryMissing();
    }

    return {
      agent,
      handler,
      prompt: (prompt) =>
        Effect.gen(function* () {
          if (turn) {
            return yield* new TurnInProgress({ agent });
          }
          const turnId = yield* ids.next;
          yield* options.onEvent({ type: 'turn_started', turnId, prompt });
          const executable = yield* findExecutable;
          if (Option.isNone(executable)) {
            yield* reportBinaryMissing(turnId);
            yield* options.onEvent({ type: 'turn_ended', turnId, stopReason: 'error' });
            return 'error';
          }
          const started = handler.newTurn(turnId, yield* Deferred.make<StopReason>(), options.onEvent);
          turn = started;
          yield* handler.runTurn(started, executable.value, prompt);
          return yield* started.awaitEnd();
        }),
      cancel: () =>
        Effect.suspend(() => {
          const running = turn;
          if (!running) {
            return approvals.cancelAll();
          }
          running.cancelRequested = true;
          // The agent is told the answer is cancelled before it is interrupted, so it is never left waiting.
          return Effect.zipRight(approvals.cancelAll(), handler.interrupt(running));
        }),
      respond: (requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest> => approvals.respond(requestId, optionId),
      setMode: (next) =>
        modeLock.withPermits(1)(
          Effect.suspend(() => {
            const previous = mode;
            mode = next;
            // A refused switch leaves the agent in the previous mode, so the session says so too.
            return Effect.tapError(handler.applyMode(), () => Effect.sync(() => (mode = previous)));
          })
        ),
      setModel: (next) =>
        Effect.suspend(() => {
          if (turn) {
            return new ModelChangeFailed({ agent, reason: 'Wait for the current prompt to finish.' });
          }
          const previous = model;
          model = next;
          return Effect.tapError(handler.applyModel(next), () => Effect.sync(() => { model = previous; }));
        }),
    };
  });
}

/** The services every session needs, whatever its agent. */
export type SessionServices = Executables | Ids | ModeSettings;
