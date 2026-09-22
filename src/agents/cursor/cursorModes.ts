import { Option, Schema } from 'effect';
import type { Mode } from '../events';
import { modeOverrides } from '../modes';

/** `uniAgent.cursor.modeOverrides` names an ACP session mode by its ID. */
export const CursorModeOverrides = modeOverrides(Schema.NonEmptyString);

/** Cursor's own session modes, from the one that may do the most to the one that may do the least. */
const BY_RESTRICTION = ['agent', 'plan', 'ask'];

/**
 * Cursor's `agent` mode applies edits by itself and asks before commands. It has no mode that asks
 * for nothing, so Full auto also runs in `agent` and the adapter allows every permission request.
 */
export function cursorModeId(mode: Mode): string {
  return mode === 'plan' ? 'plan' : 'agent';
}

/**
 * The session mode to run when `wanted` is the mode the mapping chose: itself if the agent offers
 * it, otherwise the nearest more restrictive mode it does offer. A mode this build does not know
 * falls back to the most restrictive one offered. None when the agent offers none of them.
 */
export function cursorSessionMode(wanted: string, available: ReadonlyArray<string>): Option.Option<string> {
  if (available.includes(wanted)) {
    return Option.some(wanted);
  }
  const known = BY_RESTRICTION.indexOf(wanted);
  const stricter = known === -1 ? [...BY_RESTRICTION].reverse() : BY_RESTRICTION.slice(known + 1);
  return Option.fromNullable(stricter.find((id) => available.includes(id)));
}
