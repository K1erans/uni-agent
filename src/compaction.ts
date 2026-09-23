import type { AgentEvent, ContentBlock, ToolCall, ToolCallUpdate } from './agents/events';
import type { ChunkKind } from './agents/turn';

/**
 * One stored event. Rows replay in `seq` order, then `part` order. A `seq` is taken when an item is
 * first seen, so the item keeps its place among the others even though it is written only once it
 * has finished.
 */
export interface CompactedEvent {
  readonly seq: number;
  readonly part: number;
  readonly turnId: string | undefined;
  readonly event: AgentEvent;
  /** When the item was first seen, in milliseconds since the epoch. */
  readonly at: number;
}

interface PendingText {
  readonly seq: number;
  readonly at: number;
  readonly turnId: string;
  readonly kind: ChunkKind;
  readonly messageId: string;
  text: string;
}

interface PendingTool {
  readonly seq: number;
  readonly at: number;
  readonly turnId: string;
  call: ToolCall;
  /** The permission requests about the call and their answers, in the order they arrived. */
  readonly permissions: AgentEvent[];
}

interface PendingPlan {
  readonly seq: number;
  readonly at: number;
  event: AgentEvent;
}

/**
 * Turns a thread's live events into the rows that store its history. Streaming deltas stay here
 * until their item finishes, and then each item is written once:
 * - a message or thought, with its chunks merged, once something else arrives;
 * - a tool call, in its final state, once it completes or fails (or its turn ends), after the
 *   permission requests about it and their answers, so replaying them leaves the final state;
 * - a plan, as it last stood, when its turn ends.
 * Turn boundaries, errors in a turn and the session's configuration are written as they arrive.
 * Errors outside a turn describe the agent's setup at the time, and session IDs are kept with the
 * thread, so neither is written as an event.
 *
 * Replaying the rows through the webview's reducer shows the same transcript the live events did.
 */
export class Compactor {
  private text: PendingText | undefined;
  private readonly tools = new Map<string, PendingTool>();
  private plan: PendingPlan | undefined;

  /** @param nextSeq The first `seq` not yet used by the thread's stored rows. */
  constructor(private nextSeq: number) {}

  /** The rows to write now that `event` has arrived. */
  push(event: AgentEvent, at: number): ReadonlyArray<CompactedEvent> {
    if (event.type === 'session_update' && (event.update.sessionUpdate === 'agent_message_chunk' || event.update.sessionUpdate === 'agent_thought_chunk')) {
      const { sessionUpdate: kind, messageId, content } = event.update;
      const text = this.text;
      if (text && text.kind === kind && text.messageId === messageId && text.turnId === event.turnId) {
        text.text += content.text;
        return [];
      }
      const written = this.flushText();
      this.text = { seq: this.nextSeq++, at, turnId: event.turnId, kind, messageId, text: content.text };
      return written;
    }
    const written = [...this.flushText()];
    switch (event.type) {
      case 'session_started':
        break;
      case 'error':
        if (event.turnId !== undefined) {
          written.push(this.single(event, event.turnId, at));
        }
        break;
      case 'session_configured':
      case 'turn_started':
        written.push(this.single(event, eventTurnId(event), at));
        break;
      case 'turn_ended':
        written.push(...this.flushAll(), this.single(event, event.turnId, at));
        break;
      case 'permission_request': {
        const tool = this.tools.get(event.toolCall.toolCallId) ?? this.track(event.turnId, { ...event.toolCall, status: 'pending' }, at);
        tool.permissions.push(event);
        break;
      }
      case 'permission_resolved': {
        const tool = [...this.tools.values()].find((candidate) => candidate.permissions.some((asked) => asked.type === 'permission_request' && asked.requestId === event.requestId));
        if (tool) {
          tool.permissions.push(event);
        } else {
          written.push(this.single(event, event.turnId, at));
        }
        break;
      }
      case 'session_update': {
        const { update } = event;
        switch (update.sessionUpdate) {
          case 'tool_call':
          case 'tool_call_update': {
            const tool = this.tools.get(update.toolCallId);
            if (tool) {
              tool.call = mergeToolCall(tool.call, update);
            } else if (update.sessionUpdate === 'tool_call') {
              const { sessionUpdate: _, ...call } = update;
              this.track(event.turnId, call, at);
            } else {
              // News about a call already written: its own row, which replay merges into the call.
              written.push(this.single(event, event.turnId, at));
              break;
            }
            const call = this.tools.get(update.toolCallId);
            if (call && (call.call.status === 'completed' || call.call.status === 'failed')) {
              written.push(...this.flushTool(call));
            }
            break;
          }
          case 'plan':
            this.plan = this.plan ? { ...this.plan, event } : { seq: this.nextSeq++, at, event };
            break;
          default:
            break;
        }
        break;
      }
    }
    return written;
  }

  private single(event: AgentEvent, turnId: string | undefined, at: number): CompactedEvent {
    return { seq: this.nextSeq++, part: 0, turnId, event, at };
  }

  private track(turnId: string, call: ToolCall, at: number): PendingTool {
    const tool: PendingTool = { seq: this.nextSeq++, at, turnId, call, permissions: [] };
    this.tools.set(call.toolCallId, tool);
    return tool;
  }

  private flushText(): ReadonlyArray<CompactedEvent> {
    const text = this.text;
    this.text = undefined;
    if (!text) {
      return [];
    }
    const content: ContentBlock = { type: 'text', text: text.text };
    const event: AgentEvent = { type: 'session_update', turnId: text.turnId, update: { sessionUpdate: text.kind, messageId: text.messageId, content } };
    return [{ seq: text.seq, part: 0, turnId: text.turnId, event, at: text.at }];
  }

  private flushTool(tool: PendingTool): ReadonlyArray<CompactedEvent> {
    this.tools.delete(tool.call.toolCallId);
    const events: AgentEvent[] = [...tool.permissions, { type: 'session_update', turnId: tool.turnId, update: { sessionUpdate: 'tool_call', ...tool.call } }];
    return events.map((event, part) => ({ seq: tool.seq, part, turnId: tool.turnId, event, at: tool.at }));
  }

  private flushAll(): ReadonlyArray<CompactedEvent> {
    const plan = this.plan;
    this.plan = undefined;
    const written = [...this.tools.values()].flatMap((tool) => this.flushTool(tool));
    if (plan) {
      written.push({ seq: plan.seq, part: 0, turnId: eventTurnId(plan.event), event: plan.event, at: plan.at });
    }
    return written.sort((a, b) => a.seq - b.seq || a.part - b.part);
  }
}

/** A tool call with what an update said about it; fields the agent left out keep the value they had. */
function mergeToolCall(call: ToolCall, update: ToolCallUpdate): ToolCall {
  return {
    toolCallId: call.toolCallId,
    title: update.title ?? call.title,
    kind: update.kind ?? call.kind,
    status: update.status ?? call.status,
    content: update.content ?? call.content,
    rawInput: update.rawInput === undefined ? call.rawInput : update.rawInput,
    rawOutput: update.rawOutput === undefined ? call.rawOutput : update.rawOutput,
  };
}

function eventTurnId(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'session_started':
    case 'session_configured':
      return undefined;
    default:
      return event.turnId;
  }
}
