import { Effect, Schema, Stream } from 'effect';
import type { Options, SDKUserMessage, Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * What Uni Agent knows of Claude Code beyond one session: the CLI's name, and the models it
 * offers. The session adapter and model discovery both use it, so the two cannot drift apart.
 */

/** The CLI on PATH, which the Agent SDK drives. */
export const CLAUDE_COMMAND = 'claude';

/** Starts a Claude Code query; the Agent SDK's `query`, or a test's fake. */
export type ClaudeQueryStart = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Pick<Query, 'supportedModels' | 'close'>;

const ClaudeModels = Schema.Array(Schema.Struct({ value: Schema.NonEmptyString, displayName: Schema.NonEmptyString }));

/** A model Claude Code offers: the value to select it by, and its name. */
export type ClaudeModel = (typeof ClaudeModels.Type)[number];

/**
 * The models Claude Code at `executable` offers. It starts a query that is never sent a prompt,
 * asks it, and closes it again. Fails with why, as Claude said it.
 */
export function claudeModels(query: ClaudeQueryStart, executable: string, cwd: string): Effect.Effect<ReadonlyArray<ClaudeModel>, string> {
  return Effect.gen(function* () {
    const started = yield* Effect.try({
      try: () => query({ prompt: Stream.toAsyncIterable(Stream.never), options: { cwd, pathToClaudeCodeExecutable: executable } }),
      catch: reasonOf,
    });
    const models = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await started.supportedModels();
        } finally {
          started.close();
        }
      },
      catch: reasonOf,
    });
    return yield* Effect.mapError(Schema.decodeUnknown(ClaudeModels)(models), (error) => error.message);
  });
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
