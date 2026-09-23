import type {
  AgentErrorCode,
  PermissionOption,
  PermissionOutcome,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from './agents/events';
import type { ThreadEvent } from './protocol';

/**
 * A thread's transcript: its turns and what each one showed, folded from the thread's events.
 * The one place the transcript's rules live (how chunks group into messages, how an update merges
 * into a tool call, when a permission request is open, what a turn's status is), shared by the
 * webview, which renders it, and the extension, which reads a thread's status from it. Pure, so
 * both bundles import it.
 */

export interface ErrorItem {
  kind: 'error';
  id: string;
  code: AgentErrorCode;
  message: string;
}

/** A streamed piece of the agent's reply or thinking, grouped by the agent's message ID. */
export interface TextItem {
  id: string;
  text: string;
  /** Where this arrived among everything the turn has shown, so replies and tool calls read in order. */
  index: number;
}

/** A permission request the agent is waiting on, or the answer it was given. */
export interface Approval {
  requestId: string;
  options: ReadonlyArray<PermissionOption>;
  /** How it was answered; undefined while the agent is still waiting. */
  outcome: PermissionOutcome | undefined;
}

/** One tool the agent ran or asked to run, with whatever it has said about it so far. */
export interface ToolCallItem {
  id: string;
  title: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  content: ReadonlyArray<ToolCallContent>;
  rawInput: unknown;
  rawOutput: unknown;
  approval: Approval | undefined;
  index: number;
}

/** One prompt and everything the agent sent back for it. */
export interface TurnItem {
  kind: 'turn';
  id: string;
  prompt: string;
  /** When the turn started and ended, in milliseconds since the epoch. */
  startedAt: number;
  endedAt: number | undefined;
  /** Why the turn ended; undefined while it runs. */
  stopReason: StopReason | undefined;
  thoughts: TextItem[];
  messages: TextItem[];
  tools: ToolCallItem[];
  errors: ErrorItem[];
}

/** Turns, and errors that happened outside a turn (such as the agent's CLI missing at startup). */
export type TranscriptItem = TurnItem | ErrorItem;

export interface SessionConfig {
  model: string;
  permissionMode: string;
}


/** A transcript, and what the agent last reported about its session. */
export interface Transcript {
  items: TranscriptItem[];
  /** What the agent last reported running the session with; undefined until its process starts. */
  config: SessionConfig | undefined;
  /** A turn is in progress. */
  running: boolean;
  /** The code of the latest error since the last turn started. */
  lastError: AgentErrorCode | undefined;
}

export const emptyTranscript: Transcript = { items: [], config: undefined, running: false, lastError: undefined };

/** The transcript these events add up to. */
export function foldTranscript(events: ReadonlyArray<ThreadEvent>): Transcript {
  return events.reduce(applyEvent, emptyTranscript);
}

/**
 * Folds one agent event into a transcript, or into any state that holds one. Items that do not
 * change keep their identity, so
 * memoised components re-render only for the turn, and the text, that is streaming.
 */
export function applyEvent<S extends Transcript>(state: S, { event, at }: ThreadEvent): S {
  switch (event.type) {
    case 'session_configured':
      return { ...state, config: { model: event.model, permissionMode: event.permissionMode } };
    case 'turn_started': {
      const turn: TurnItem = {
        kind: 'turn',
        id: event.turnId,
        prompt: event.prompt.map((block) => block.text).join('\n'),
        startedAt: at,
        endedAt: undefined,
        stopReason: undefined,
        thoughts: [],
        messages: [],
        tools: [],
        errors: [],
      };
      return { ...state, items: [...state.items, turn], running: true, lastError: undefined };
    }
    case 'turn_ended':
      return {
        ...state,
        items: updateTurn(state.items, event.turnId, (turn) => ({ ...turn, endedAt: at, stopReason: event.stopReason })),
        running: false,
      };
    case 'error': {
      const { turnId, code, message } = event;
      const turnIndex = turnId === undefined ? -1 : findTurn(state.items, turnId);
      if (turnIndex === -1) {
        return { ...state, items: [...state.items, { kind: 'error', id: `error:${state.items.length}`, code, message }], lastError: code };
      }
      return {
        ...state,
        items: replaceAt(state.items, turnIndex, (turn) => ({
          ...turn,
          errors: [...turn.errors, { kind: 'error', id: `${turn.id}:error:${turn.errors.length}`, code, message }],
        })),
        lastError: code,
      };
    }
    case 'session_update': {
      const { update } = event;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          const field = update.sessionUpdate === 'agent_message_chunk' ? 'messages' : 'thoughts';
          return {
            ...state,
            items: updateTurn(state.items, event.turnId, (turn) => ({
              ...turn,
              [field]: appendText(turn[field], update.messageId, update.content.text, nextIndex(turn)),
            })),
          };
        }
        case 'tool_call':
          return { ...state, items: updateTurn(state.items, event.turnId, (turn) => withToolCall(turn, update)) };
        case 'tool_call_update':
          return {
            ...state,
            items: updateTurn(state.items, event.turnId, (turn) => updateToolCall(turn, update.toolCallId, (tool) => merged(tool, update))),
          };
        default:
          return state;
      }
    }
    case 'permission_request':
      return {
        ...state,
        items: updateTurn(state.items, event.turnId, (turn) => {
          // The ask and the tool call are the same thing: the card belongs to the call it is about.
          const asked = withToolCall(turn, { ...event.toolCall, status: 'pending' });
          return updateToolCall(asked, event.toolCall.toolCallId, (tool) => ({
            ...tool,
            approval: { requestId: event.requestId, options: event.options, outcome: undefined },
          }));
        }),
      };
    case 'permission_resolved': {
      const { requestId, outcome } = event;
      return {
        ...state,
        items: updateTurn(state.items, event.turnId, (turn) => {
          const tool = turn.tools.find((candidate) => candidate.approval?.requestId === requestId);
          return tool === undefined
            ? turn
            : updateToolCall(turn, tool.id, (answered) => ({
                ...answered,
                approval: answered.approval && { ...answered.approval, outcome },
                // The agent reports what the tool then did; until it does, the answer itself says
                // whether the call went ahead.
                status: answered.status === 'pending' ? statusAfter(answered, outcome) : answered.status,
              }));
        }),
      };
    }
    default:
      return state;
  }
}

/** The index of the turn with this ID, searching from the end where the running turn is. */
function findTurn(items: TranscriptItem[], turnId: string): number {
  return items.findLastIndex((item) => item.kind === 'turn' && item.id === turnId);
}

function replaceAt(items: TranscriptItem[], index: number, update: (turn: TurnItem) => TurnItem): TranscriptItem[] {
  const item = items[index];
  if (item.kind !== 'turn') {
    return items;
  }
  const next = items.slice();
  next[index] = update(item);
  return next;
}

function updateTurn(items: TranscriptItem[], turnId: string, update: (turn: TurnItem) => TurnItem): TranscriptItem[] {
  const index = findTurn(items, turnId);
  return index === -1 ? items : replaceAt(items, index, update);
}

function appendText(items: TextItem[], id: string, text: string, index: number): TextItem[] {
  // The streaming item is almost always the last one, so search from the end.
  const at = items.findLastIndex((item) => item.id === id);
  if (at === -1) {
    return [...items, { id, text, index }];
  }
  const next = items.slice();
  next[at] = { ...items[at], text: items[at].text + text };
  return next;
}

/** Where the next thing the turn shows belongs in the order everything arrived in. */
function nextIndex(turn: TurnItem): number {
  return turn.messages.length + turn.thoughts.length + turn.tools.length;
}

/** Adds a tool call, or replaces what is known about one already shown. */
function withToolCall(turn: TurnItem, call: ToolCall): TurnItem {
  const known = turn.tools.some((tool) => tool.id === call.toolCallId);
  if (known) {
    return updateToolCall(turn, call.toolCallId, (tool) => merged(tool, call));
  }
  return {
    ...turn,
    tools: [
      ...turn.tools,
      {
        id: call.toolCallId,
        title: call.title,
        toolKind: call.kind,
        status: call.status,
        content: call.content ?? [],
        rawInput: call.rawInput,
        rawOutput: call.rawOutput,
        approval: undefined,
        index: nextIndex(turn),
      },
    ],
  };
}

/** A tool call with what an update said about it; fields the agent left out keep the value they had. */
function merged(tool: ToolCallItem, update: Partial<ToolCall>): ToolCallItem {
  return {
    ...tool,
    title: told(update.title, tool.title),
    toolKind: told(update.kind, tool.toolKind),
    status: told(update.status, tool.status),
    content: told(update.content, tool.content),
    rawInput: told(update.rawInput, tool.rawInput),
    rawOutput: told(update.rawOutput, tool.rawOutput),
  };
}

function told<A>(update: A | undefined, known: A): A {
  return update === undefined ? known : update;
}

function updateToolCall(turn: TurnItem, toolCallId: string, update: (tool: ToolCallItem) => ToolCallItem): TurnItem {
  const index = turn.tools.findLastIndex((tool) => tool.id === toolCallId);
  if (index === -1) {
    return turn;
  }
  const tools = turn.tools.slice();
  tools[index] = update(tools[index]);
  return { ...turn, tools };
}

/** What became of a tool call the user has just answered for, until the agent says more. */
function statusAfter(tool: ToolCallItem, outcome: PermissionOutcome): ToolCallStatus {
  if (outcome.outcome === 'cancelled') {
    return 'failed';
  }
  const chosen = tool.approval?.options.find((option) => option.optionId === outcome.optionId);
  return chosen?.kind === 'allow_once' || chosen?.kind === 'allow_always' ? 'in_progress' : 'failed';
}

/** The tool calls a turn is waiting on an answer for. */
export function waitingToolCalls(turn: TurnItem): ToolCallItem[] {
  return turn.tools.filter((tool) => tool.approval !== undefined && tool.approval.outcome === undefined);
}

/** Whether the agent is waiting for the user to answer a permission request. */
export function awaitingApproval(state: Transcript): boolean {
  return state.items.some((item) => item.kind === 'turn' && waitingToolCalls(item).length > 0);
}

