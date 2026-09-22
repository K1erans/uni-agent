import { Deferred, Effect, Option, type Context, type Schema, type Scope } from 'effect';
import type { Ids } from '../ids';
import { binaryMissingMessage, TurnInProgress, type AdapterOptions, type AgentAdapter, type UnknownPermissionRequest } from './adapter';
import { Approvals } from './approvals';
import { AGENT_NAMES, type AgentEvent, type AgentKind, type ContentBlock, type Mode, type StopReason } from './events';
import type { Executables } from './findExecutable';
import { nativeMode, type ModeOverrides, type ModeSettings } from './modes';
import type { Turn } from './turn';

/**
 * What every adapter shares: one turn at a time, finding the agent's CLI, reporting a crash, and
 * ending the running turn as `cancelled` when the adapter's scope closes. Subclasses start the
 * agent process and translate its traffic.
 */
export abstract class BaseAdapter<T extends Turn> implements AgentAdapter {
  abstract readonly agent: AgentKind;
  /** The agent CLI's name on PATH. */
  protected abstract readonly command: string;

  /** The permission requests waiting for the user, shared by every turn of this adapter. */
  protected readonly approvals: Approvals;

  protected turn: T | undefined;
  /** The mode the user chose; the agent runs in it from when it starts, or as soon as it can after a change. */
  protected mode: Mode;
  /** Whether the scope has closed, so the process stopping is expected rather than a crash. */
  protected disposed = false;

  protected constructor(
    protected readonly options: AdapterOptions,
    private readonly executables: Context.Tag.Service<Executables>,
    protected readonly ids: Context.Tag.Service<Ids>,
    private readonly modeSettings: Context.Tag.Service<ModeSettings>,
    protected readonly scope: Scope.Scope
  ) {
    this.approvals = new Approvals((event) => this.options.onEvent(event));
    this.mode = options.mode;
  }

  /** Makes a turn of this adapter's kind. */
  protected abstract newTurn(id: string, ended: Deferred.Deferred<StopReason>): T;

  /** Starts the agent if it is not running and sends it the prompt. The turn ends through `endTurn`. */
  protected abstract runTurn(turn: T, executable: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<void>;

  /** Asks the agent to stop the running turn; `turn.cancelRequested` is already set. */
  protected abstract interrupt(turn: T): Effect.Effect<void>;

  /** Stops the agent process, if one is running, without reporting it. */
  protected abstract stop(): Effect.Effect<void>;

  /** Applies `this.mode` to the running agent, if any; an agent that starts later starts in it. */
  protected abstract applyMode(): Effect.Effect<void>;

  /** Called by `make` once the adapter is built: stops the agent with the scope and reports a missing CLI. */
  protected start(): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen(this, function* () {
      yield* Effect.addFinalizer(() => this.dispose());
      if (Option.isNone(yield* this.findExecutable())) {
        yield* this.reportBinaryMissing();
      }
    });
  }

  prompt(prompt: ReadonlyArray<ContentBlock>): Effect.Effect<StopReason, TurnInProgress> {
    return Effect.gen(this, function* () {
      if (this.turn) {
        return yield* new TurnInProgress({ agent: this.agent });
      }
      const turnId = yield* this.ids.next;
      yield* this.emit({ type: 'turn_started', turnId, prompt });

      const executable = yield* this.findExecutable();
      if (Option.isNone(executable)) {
        yield* this.reportBinaryMissing(turnId);
        yield* this.emit({ type: 'turn_ended', turnId, stopReason: 'error' });
        return 'error';
      }

      const turn = this.newTurn(turnId, yield* Deferred.make<StopReason>());
      this.turn = turn;
      yield* this.runTurn(turn, executable.value, prompt);
      return yield* turn.awaitEnd();
    });
  }

  cancel(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const turn = this.turn;
      if (!turn) {
        return this.approvals.cancelAll();
      }
      turn.cancelRequested = true;
      // The agent is told the answer is cancelled before it is interrupted, so it is never left waiting.
      return Effect.zipRight(this.approvals.cancelAll(), this.interrupt(turn));
    });
  }

  respond(requestId: string, optionId: string): Effect.Effect<void, UnknownPermissionRequest> {
    return this.approvals.respond(requestId, optionId);
  }

  setMode(mode: Mode): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.mode = mode;
      return this.applyMode();
    });
  }

  /**
   * The agent's native settings for the current mode: the user's override for it, if the agent's
   * `modeOverrides` setting names one, otherwise `builtIn`'s.
   */
  protected native<A, I>(builtIn: (mode: Mode) => A, overrides: Schema.Schema<ModeOverrides<A>, I>): Effect.Effect<A> {
    return Effect.map(this.modeSettings.overrides(this.agent, overrides), (set) => nativeMode(this.mode, builtIn, set));
  }

  /** Ends `turn` if it is still the running one. */
  protected endTurn(turn: T, stopReason: StopReason): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.turn !== turn) {
        return Effect.void;
      }
      this.turn = undefined;
      // Nothing answers a request once its turn is over, so none is left waiting.
      return Effect.zipRight(this.approvals.cancelAll(), turn.end(stopReason));
    });
  }

  /** Reports that the agent process stopped unexpectedly, ending the running turn as `error`. */
  protected crashed(reason: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.logDebug(`${AGENT_NAMES[this.agent]} stopped: ${reason}`);
      const turn = this.turn;
      yield* this.emit({
        type: 'error',
        turnId: turn?.id,
        code: 'process_crashed',
        message: `${AGENT_NAMES[this.agent]} stopped unexpectedly: ${reason}`,
      });
      if (turn) {
        yield* this.endTurn(turn, 'error');
      }
    });
  }

  protected emit(event: AgentEvent): Effect.Effect<void> {
    return this.options.onEvent(event);
  }

  private dispose(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.disposed = true;
      yield* this.approvals.cancelAll();
      yield* this.stop();
      if (this.turn) {
        yield* this.endTurn(this.turn, 'cancelled');
      }
    });
  }

  private reportBinaryMissing(turnId?: string): Effect.Effect<void> {
    return this.emit({
      type: 'error',
      turnId,
      code: 'binary_missing',
      message: binaryMissingMessage(this.agent, this.command, this.options.executablePath),
    });
  }

  private findExecutable(): Effect.Effect<Option.Option<string>> {
    return this.executables.find(this.command, this.options.executablePath);
  }
}
