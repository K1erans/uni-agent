import { Clock, Data, Effect, Fiber, type Scope } from 'effect';
import type { EventSink, MakeAdapter } from './agents/adapter';
import { AGENT_NAMES, DEFAULT_MODE, MODE_NAMES, type AgentEvent, type AgentKind, type Mode, type StopReason } from './agents/events';
import { threadTitle, type ExtensionMessage, type ThreadEvent, type ThreadInfo } from './protocol';

/** Where a thread's agent runs. */
export interface Workspace {
  readonly cwd: string;
  /** The workspace folder's name; null when no folder is open and the agent runs in the home directory. */
  readonly name: string | null;
}

/** Delivers a message to the connected webview. */
export type Post = (message: ExtensionMessage) => Effect.Effect<void>;

export class PromptRejected extends Data.TaggedError('PromptRejected')<{ readonly reason: 'busy' | 'empty' }> {}

export interface TurnResult {
  readonly agent: AgentKind;
  readonly model: string | undefined;
  readonly sessionId: string | undefined;
  readonly stopReason: StopReason;
  readonly response: string;
  readonly events: ReadonlyArray<AgentEvent>;
}

export type PromptAdmission =
  | { readonly status: 'accepted'; readonly completion: Effect.Effect<TurnResult> }
  | { readonly status: 'rejected'; readonly reason: 'busy' | 'empty' };

/**
 * One conversation with one agent. Keeps every event the adapter emits, stamped with when it
 * arrived, so a webview that (re)loads or switches to this thread is brought up to date by
 * replaying them. The thread and its adapter live in the scope that makes them; closing it stops
 * the agent.
 */
export interface Thread {
  readonly info: ThreadInfo;
  readonly workspace: Workspace;
  /** The first prompt's title; undefined until the first turn starts. */
  readonly title: string | undefined;
  /** Whether no prompt has been sent yet. */
  readonly isEmpty: boolean;
  /** Whether the agent is waiting for the user to answer a permission request. */
  readonly needsApproval: boolean;
  /** How freely the agent may act; new threads start in {@link DEFAULT_MODE}. */
  readonly mode: Mode;
  /** Connects a webview, replacing any previous one, and sends it the history so far. */
  attach(post: Post): Effect.Effect<void>;
  /** Stops forwarding events to the connected webview. */
  detach(): Effect.Effect<void>;
  /** Reserves a turn immediately and reports whether the prompt was admitted. */
  prompt(text: string): Effect.Effect<PromptAdmission>;
  /** Reserves a turn and waits for its reviewable result. */
  run(text: string): Effect.Effect<TurnResult, PromptRejected>;
  /** Stops the running turn. */
  cancel(): Effect.Effect<void>;
  /** Answers a permission request the agent is waiting on; an answer it cannot place is logged and dropped. */
  respond(requestId: string, optionId: string): Effect.Effect<void>;
  /**
   * Switches the thread's mode, including mid-turn, and tells the connected webview. If the agent
   * refuses, the thread keeps its mode and logs why. Checking Full auto is allowed is the caller's job.
   */
  setMode(mode: Mode): Effect.Effect<void>;
}

/**
 * The permission requests a thread's events leave open: those announced and not resolved since.
 * Adapters resolve every request before their turn ends, so this is empty between turns.
 */
export function openApprovals(events: ReadonlyArray<ThreadEvent>): ReadonlySet<string> {
  const open = new Set<string>();
  for (const { event } of events) {
    if (event.type === 'permission_request') {
      open.add(event.requestId);
    } else if (event.type === 'permission_resolved') {
      open.delete(event.requestId);
    }
  }
  return open;
}

/**
 * @param onChanged Told whenever the thread has seen an event, so a view outside the webview (the
 * thread list, the sidebar's badge) can catch up with, for example, a thread waiting for approval.
 */
export function makeThread<R>(
  id: string,
  workspace: Workspace,
  makeAdapter: MakeAdapter<R>,
  onChanged: () => Effect.Effect<void> = () => Effect.void,
  onEvent: EventSink = () => Effect.void,
  model?: string,
  initialMode: Mode = DEFAULT_MODE
): Effect.Effect<Thread, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const history: ThreadEvent[] = [];
    let post: Post | undefined;
    let running = false;
    let prompted = false;
    let title: string | undefined;
    let mode = initialMode;
    let sessionId: string | undefined;
    let configuredModel: string | undefined;
    // Mode changes arrive on fibers of their own; one at a time keeps the mode shown in step with
    // the one the agent runs in.
    const modeLock = yield* Effect.makeSemaphore(1);

    const adapter = yield* makeAdapter((event) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => {
        if (event.type === 'session_started') {
          sessionId = event.sessionId;
        } else if (event.type === 'session_configured') {
          configuredModel = event.model;
        }
        if (event.type === 'turn_started' && title === undefined) {
          title = threadTitle(event.prompt.map((block) => block.text).join('\n'));
        }
        history.push({ event, at });
        return Effect.zipRight(Effect.zipRight(post ? post({ type: 'event', threadId: id, event, at }) : Effect.void, onChanged()), onEvent(event));
      }),
      mode,
      model
    );
    // Finalizers run in reverse, so this runs before the adapter stops and its last events are not
    // posted to a closed webview.
    yield* Effect.addFinalizer(() => Effect.sync(() => (post = undefined)));

    const info: ThreadInfo = { id, agent: adapter.agent, workspace: workspace.name };
    const prompt = (text: string): Effect.Effect<PromptAdmission> =>
      Effect.suspend(() => {
        if (!text.trim()) {
          return Effect.succeed({ status: 'rejected' as const, reason: 'empty' as const });
        }
        if (running) {
          return Effect.succeed({ status: 'rejected' as const, reason: 'busy' as const });
        }
        running = true;
        prompted = true;
        const from = history.length;
        const turn = adapter.prompt([{ type: 'text', text }]).pipe(
          Effect.orDie,
          Effect.map((stopReason): TurnResult => {
            const events = history.slice(from).map(({ event }) => event);
            return { agent: adapter.agent, model: configuredModel, sessionId, stopReason, response: replyText(events), events };
          }),
          Effect.ensuring(Effect.sync(() => { running = false; }))
        );
        return Effect.map(Effect.forkIn(turn, scope), (fiber): PromptAdmission => ({ status: 'accepted', completion: Fiber.join(fiber) }));
      });
    return {
      info,
      workspace,
      get title() {
        return title;
      },
      get isEmpty() {
        return !prompted;
      },
      get needsApproval() {
        return openApprovals(history).size > 0;
      },
      get mode() {
        return mode;
      },
      attach: (next) =>
        Effect.suspend(() => {
          post = next;
          return next({ type: 'history', thread: info, mode, events: [...history] });
        }),
      detach: () => Effect.sync(() => (post = undefined)),
      prompt,
      run: (text) => Effect.flatMap(prompt(text), (admission) =>
        admission.status === 'accepted' ? admission.completion : new PromptRejected({ reason: admission.reason })
      ),
      cancel: () => adapter.cancel(),
      respond: (requestId, optionId) =>
        // An answer for a request that is no longer open (the turn ended, or a second click) is
        // nothing to act on, and never a reason to break the thread.
        Effect.catchTag(adapter.respond(requestId, optionId), 'UnknownPermissionRequest', (error) =>
          Effect.logDebug(`Ignored an answer for permission request ${error.requestId} of thread ${id}`)
        ),
      setMode: (next) =>
        modeLock.withPermits(1)(
          adapter.setMode(next).pipe(
            // Only a switch the agent accepted is shown: the webview must never show a stricter mode
            // than the agent really runs in.
            Effect.zipRight(
              Effect.suspend(() => {
                mode = next;
                return post ? post({ type: 'mode', threadId: id, mode: next }) : Effect.void;
              })
            ),
            Effect.catchTag('ModeChangeFailed', (error) =>
              Effect.logWarning(`${AGENT_NAMES[error.agent]} refused to switch thread ${id} to ${MODE_NAMES[error.mode]}; it keeps ${MODE_NAMES[mode]}: ${error.reason}`)
            )
          )
        ),
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
