import {
  query as sdkQuery,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import * as crypto from 'node:crypto';
import { AgentEventEmitter, type AgentAdapter } from '../adapter';
import { AsyncQueue } from '../asyncQueue';
import type { AgentErrorCode, ContentBlock, StopReason } from '../events';
import { findExecutable } from '../findExecutable';

/** The part of the Agent SDK's `Query` the adapter uses; lets tests substitute a fake agent. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

export interface ClaudeAdapterOptions {
  /** The thread's working directory. */
  cwd: string;
  /** The `uniAgent.claude.executablePath` setting; empty or unset means search PATH for `claude`. */
  executablePath?: string;
  /** Starts the native session; defaults to the Agent SDK's `query`. */
  query?: ClaudeQueryFn;
  /** Resolves the `claude` binary; defaults to a PATH search. */
  findClaude?: (override: string | undefined) => string | undefined;
  /** Generates session and turn IDs; the session ID must be a UUID. */
  newId?: () => string;
  log?: (line: string) => void;
}

interface Turn {
  turnId: string;
  resolve: (stopReason: StopReason) => void;
  /** API message IDs whose content arrived as stream events, so their complete copies are skipped. */
  streamedMessageIds: Set<string>;
  errorReported: boolean;
  cancelRequested: boolean;
}

interface Connection {
  query: ClaudeQuery;
  input: AsyncQueue<SDKUserMessage>;
}

const STDERR_TAIL_LINES = 20;
const NOT_SIGNED_IN_ERRORS = new Set<SDKAssistantMessage['error']>(['authentication_failed', 'oauth_org_not_allowed']);

/**
 * Drives the user's own, unmodified `claude` binary through the Claude Agent SDK. Uni Agent never
 * touches Claude credentials: the binary signs in and authenticates by itself.
 *
 * The session ID is generated here and handed to Claude, so it is known before the first prompt.
 * One long-lived streaming-input query serves every turn; if the process dies, the next prompt
 * starts a new one that resumes the session.
 */
export class ClaudeAdapter extends AgentEventEmitter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly sessionId: string;

  private readonly query: ClaudeQueryFn;
  private readonly findClaude: (override: string | undefined) => string | undefined;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;

  private connection: Connection | undefined;
  private turn: Turn | undefined;
  /** Whether Claude has written the session, so a restart must resume it rather than create it. */
  private sessionExists = false;
  /** The API message currently streaming, which content-block deltas belong to. */
  private streamingMessageId: string | undefined;
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private readonly options: ClaudeAdapterOptions) {
    super();
    this.query = options.query ?? sdkQuery;
    this.findClaude = options.findClaude ?? ((override) => findExecutable('claude', { override }));
    this.newId = options.newId ?? crypto.randomUUID;
    this.log = options.log ?? (() => {});
    this.sessionId = this.newId();
  }

  start(): void {
    this.emit({ type: 'session_started', agent: this.agent, sessionId: this.sessionId });
    if (!this.findClaude(this.options.executablePath || undefined)) {
      this.emit({ type: 'error', code: 'binary_missing', message: this.binaryMissingMessage() });
    }
  }

  prompt(prompt: ContentBlock[]): Promise<StopReason> {
    if (this.turn) {
      throw new Error('A turn is already running in this session');
    }
    const turnId = this.newId();
    this.emit({ type: 'turn_started', turnId, prompt });

    const executable = this.findClaude(this.options.executablePath || undefined);
    if (!executable) {
      this.emit({ type: 'error', turnId, code: 'binary_missing', message: this.binaryMissingMessage() });
      this.emit({ type: 'turn_ended', turnId, stopReason: 'error' });
      return Promise.resolve('error');
    }

    const ended = new Promise<StopReason>((resolve) => {
      this.turn = { turnId, resolve, streamedMessageIds: new Set(), errorReported: false, cancelRequested: false };
    });
    this.connect(executable).input.push({
      type: 'user',
      message: { role: 'user', content: prompt.map((block) => ({ type: 'text', text: block.text })) },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    });
    return ended;
  }

  async cancel(): Promise<void> {
    if (this.turn && this.connection) {
      this.turn.cancelRequested = true;
      await this.connection.query.interrupt();
    }
  }

  dispose(): void {
    this.disposed = true;
    const connection = this.connection;
    this.connection = undefined;
    connection?.input.close();
    connection?.query.close();
    if (this.turn) {
      this.endTurn('cancelled');
    }
  }

  private connect(executable: string): Connection {
    if (this.connection) {
      return this.connection;
    }
    const input = new AsyncQueue<SDKUserMessage>();
    const connection: Connection = {
      input,
      query: this.query({
        prompt: input,
        options: {
          cwd: this.options.cwd,
          pathToClaudeCodeExecutable: executable,
          ...(this.sessionExists ? { resume: this.sessionId } : { sessionId: this.sessionId }),
          includePartialMessages: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'uni-agent' },
          stderr: (data) => this.recordStderr(data),
        },
      }),
    };
    this.connection = connection;
    this.stderrTail = [];
    this.log(`Started Claude Code (${executable}) for session ${this.sessionId}`);
    void this.consume(connection);
    return connection;
  }

  private async consume(connection: Connection): Promise<void> {
    let failure: string;
    try {
      for await (const message of connection.query) {
        this.handle(message);
      }
      failure = 'the process exited';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (this.disposed || this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    connection.input.close();
    const stderr = this.stderrTail.join('\n').trim();
    this.log(`Claude Code stopped: ${failure}`);
    this.emit({
      type: 'error',
      turnId: this.turn?.turnId,
      code: 'process_crashed',
      message: `Claude Code stopped unexpectedly: ${failure}` + (stderr ? `\n\n${stderr}` : ''),
    });
    if (this.turn) {
      this.endTurn('error');
    }
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case 'stream_event':
        this.sessionExists = true;
        this.handleStreamEvent(message);
        break;
      case 'assistant':
        this.sessionExists = true;
        this.handleAssistant(message);
        break;
      case 'result':
        this.sessionExists = true;
        this.handleResult(message);
        break;
    }
  }

  private handleStreamEvent({ event, parent_tool_use_id }: SDKPartialAssistantMessage): void {
    const turn = this.turn;
    // Subagent traffic belongs to its tool call, which a later ticket renders.
    if (!turn || parent_tool_use_id !== null) {
      return;
    }
    if (event.type === 'message_start') {
      this.streamingMessageId = event.message.id;
      turn.streamedMessageIds.add(event.message.id);
    } else if (event.type === 'content_block_delta' && this.streamingMessageId) {
      const messageId = `${this.streamingMessageId}:${event.index}`;
      if (event.delta.type === 'text_delta') {
        this.emitChunk(turn, 'agent_message_chunk', messageId, event.delta.text);
      } else if (event.delta.type === 'thinking_delta') {
        this.emitChunk(turn, 'agent_thought_chunk', messageId, event.delta.thinking);
      }
    }
  }

  private handleAssistant({ message, error, parent_tool_use_id }: SDKAssistantMessage): void {
    const turn = this.turn;
    if (!turn || parent_tool_use_id !== null) {
      return;
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    if (error) {
      this.reportError(turn, NOT_SIGNED_IN_ERRORS.has(error) ? 'not_signed_in' : 'agent_error', text);
      return;
    }
    // Complete copies of streamed messages carry nothing new; ones that never streamed (such as
    // messages Claude Code synthesises itself) are shown whole.
    if (turn.streamedMessageIds.has(message.id)) {
      return;
    }
    message.content.forEach((block, index) => {
      if (block.type === 'text') {
        this.emitChunk(turn, 'agent_message_chunk', `${message.id}:${index}`, block.text);
      }
    });
  }

  private handleResult(result: SDKResultMessage): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    if (turn.cancelRequested) {
      this.endTurn('cancelled');
    } else if (result.subtype === 'success' && !result.is_error) {
      this.endTurn(result.stop_reason === 'max_tokens' || result.stop_reason === 'refusal' ? result.stop_reason : 'end_turn');
    } else if (result.subtype === 'error_max_turns') {
      this.endTurn('max_turn_requests');
    } else {
      const [detail, status] =
        result.subtype === 'success' ? [result.result, result.api_error_status] : [result.errors.join('\n'), undefined];
      this.reportError(turn, status === 401 ? 'not_signed_in' : 'agent_error', detail);
      this.endTurn('error');
    }
  }

  /** Reports the turn's first error; later ones are usually the same failure echoed by the result. */
  private reportError(turn: Turn, code: AgentErrorCode, detail: string): void {
    if (turn.errorReported) {
      return;
    }
    turn.errorReported = true;
    const message =
      code === 'not_signed_in'
        ? 'Claude Code is not signed in. Run `claude` in a terminal, sign in, then try again.' +
          (detail ? `\n\n${detail}` : '')
        : detail || 'Claude Code reported an error.';
    this.emit({ type: 'error', turnId: turn.turnId, code, message });
  }

  private emitChunk(
    turn: Turn,
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    messageId: string,
    text: string
  ): void {
    if (text) {
      this.emit({ type: 'session_update', turnId: turn.turnId, update: { sessionUpdate, messageId, content: { type: 'text', text } } });
    }
  }

  private endTurn(stopReason: StopReason): void {
    const turn = this.turn!;
    this.turn = undefined;
    this.streamingMessageId = undefined;
    this.emit({ type: 'turn_ended', turnId: turn.turnId, stopReason });
    turn.resolve(stopReason);
  }

  private recordStderr(data: string): void {
    for (const line of data.split('\n')) {
      if (line.trim()) {
        this.log(`[claude stderr] ${line}`);
        this.stderrTail.push(line);
      }
    }
    this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_TAIL_LINES));
  }

  private binaryMissingMessage(): string {
    return this.options.executablePath
      ? `Claude Code was not found at "${this.options.executablePath}", the path set in uniAgent.claude.executablePath.`
      : 'Claude Code ("claude") was not found on PATH. Install Claude Code, or set uniAgent.claude.executablePath to its location.';
  }
}
