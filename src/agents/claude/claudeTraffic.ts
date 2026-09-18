import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { replayTraffic, type TrafficLine, type TrafficRecorder } from '../traffic';
import type { ClaudeQueryFn } from './claudeAdapter';

/**
 * Fields kept in fixtures for messages that describe the user's own setup: `system/init` lists
 * their tools, MCP servers and plugins, and `rate_limit_event` their plan's usage limits.
 */
const INIT_FIELDS_KEPT = ['type', 'subtype', 'session_id', 'uuid', 'cwd', 'model', 'permissionMode', 'claude_code_version'];
const RATE_LIMIT_FIELDS_KEPT = ['type', 'session_id', 'uuid'];

/**
 * Wraps a query function so its raw traffic is recorded: each user message the adapter sends and
 * each SDK message Claude sends back. Used to capture golden fixtures from the real binary.
 */
export function recordingQuery(query: ClaudeQueryFn, recorder: TrafficRecorder): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const inner = query({ prompt: tap(prompt, (message) => recorder.send(message)), options });
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of inner) {
            recorder.recv(redact(message));
            yield message;
          }
        } catch (err) {
          recorder.exit(err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
      interrupt: () => inner.interrupt(),
      close: () => inner.close(),
    };
  };
}

/** A fake Claude that replays a recorded fixture instead of running the binary. */
export function replayQuery(lines: readonly TrafficLine[]): ClaudeQueryFn {
  return ({ prompt }) => {
    const replay = replayTraffic(lines, prompt) as AsyncGenerator<SDKMessage>;
    return {
      [Symbol.asyncIterator]: () => replay,
      interrupt: async () => {},
      close: () => void replay.return(undefined),
    };
  };
}

function redact(message: SDKMessage): unknown {
  if (message.type === 'system' && message.subtype === 'init') {
    return pick(message, INIT_FIELDS_KEPT);
  }
  if (message.type === 'rate_limit_event') {
    return pick(message, RATE_LIMIT_FIELDS_KEPT);
  }
  return message;
}

function pick(message: object, keys: string[]): object {
  return Object.fromEntries(Object.entries(message).filter(([key]) => keys.includes(key)));
}

async function* tap(messages: AsyncIterable<SDKUserMessage>, onMessage: (message: SDKUserMessage) => void) {
  for await (const message of messages) {
    onMessage(message);
    yield message;
  }
}
