/**
 * The prompts the golden fixtures were recorded with. A replay must send the same text as the
 * recording, so the prompt lives next to neither test but is shared by both.
 */

/** Asks for a tool the agent can run by itself: searching the files it was started in. */
export const TOOL_CALL_PROMPT = 'Search this directory for the text TODO and reply with how many matches you found.';

/** Asks for something the agent has to get permission for: writing a file. */
export const APPROVAL_PROMPT = 'Create a file called approved.txt containing the word hi, then reply done.';

/**
 * Asks for a shell command. An agent that applies edits freely (Cursor in its agent mode) still
 * asks before running one, so this is what its approval fixture is recorded with.
 */
export const COMMAND_APPROVAL_PROMPT = 'Run the shell command `printf hi > approved.txt` in this directory, then reply done.';
