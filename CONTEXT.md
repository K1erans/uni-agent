# Uni Agent

A VS Code extension that puts existing coding-agent CLIs (Claude Code, Codex, Cursor) behind one chat UI, keeping each agent's own session, credentials and behaviour.

## Language

### Agents

**Agent**:
One of the coding-agent CLIs Uni Agent drives: Claude Code, Codex or Cursor. The user's own installation, signed in by itself.
_Avoid_: Provider, model, backend

**Native session**:
The agent's own record of a conversation, which it can resume with its full context and cache.
_Avoid_: Agent thread, conversation ID

**Agent protocol**:
How Uni Agent talks to one agent beyond a single session: how to start and greet it, and what models it offers.
_Avoid_: Client, SDK wrapper

**Mode**:
How freely an agent may act, the same three choices for every agent: Plan, Auto-edit, Full auto.
_Avoid_: Permission mode (that is the agent's own setting a mode maps onto)

### Threads

**Thread**:
One conversation with one agent in a workspace, locked to that agent once prompted; its model can change.
_Avoid_: Chat, tab, conversation, session

**Shown thread**:
The thread the sidebar displays; there is at most one.
_Avoid_: Current thread, active thread, open tab

**Turn**:
One prompt and everything the agent did in answer to it, until it ends.
_Avoid_: Exchange, message

**Transcript**:
What a thread shows: its turns, and in each the prompt, the agent's thinking and replies, its tool calls and their approvals.
_Avoid_: History (the stored events), log

**Approval**:
A permission request the agent is waiting on, and the answer the user gave it.
_Avoid_: Permission prompt, confirmation

**Title**:
A thread's name: the first line of its first prompt.

**Read-only thread**:
A thread that takes no more prompts, because its native session cannot be resumed or its stored transcript cannot be read.
_Avoid_: Broken thread, locked thread

**Interrupted turn**:
A turn that was still running when the window closed; what had finished is kept, and it counts as ended.
_Avoid_: Cancelled turn (the user stopped that one)

**Archived thread**:
A stored thread taken out of the thread list, which can be brought back.
_Avoid_: Hidden thread, closed thread

**Worktree thread**:
A thread working in its own checkout on its own branch, isolated from the workspace folder.
_Avoid_: Isolated thread, sandbox

**Worktree**:
The checkout a worktree thread works in; it exists from the thread's creation until the thread is deleted.
_Avoid_: Checkout copy, clone
