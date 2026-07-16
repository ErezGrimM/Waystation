# ADR-0004: Message Storage Layout

**Status:** Accepted
**Date:** 2026-07-16
**Deciders:** Erez
**Consulted:** Codex

## Context

Waystation stores messages as immutable JSON records under
`.waystation/messages/`, one file per message. `src/core/messages.ts` writes
messages through the same locked/atomic core write path as other ledger records,
and `src/core/validate.ts` validates message schema, duplicate ids, dangling
`in_reply_to`, and orphan threads.

Phase 8 revisited whether this should change to a per-thread JSONL layout. The
main concern is future merge friction when many agents post frequently in
parallel worktrees.

This decision sits under ADR-0003, which keeps V1 messages scoped to the current
checkout/worktree. Separate worktrees exchange messages when Git records are
merged, not through a live shared inbox.

Current observed state:

- Message volume is still small.
- Messages are immutable after creation.
- Message ids include thread, agent, timestamp, and suffix, making same-file
  collisions unlikely.
- Existing APIs (`post`, `list`, `inbox`, MCP, dashboard) already work over the
  one-file-per-record model.

## Decision Drivers

- Preserve local-first, git-friendly storage.
- Avoid a daemon, shared lock service, or non-ledger message location.
- Keep each message inspectable, diffable, and recoverable as a standalone
  canonical record.
- Avoid a storage migration before real merge friction exists.
- Keep code paths consistent with other canonical JSON records.

## Options Considered

### Option A: Keep one JSON file per message

Good:

- Matches current implementation and validation.
- Keeps messages immutable and individually mergeable.
- Avoids concurrent appends to one hot thread file.
- Fits the existing index rebuild model.
- No migration or compatibility layer required.

Bad:

- Chatty projects can create many small files.
- Thread reads must scan/load message records, though this is acceptable at the
  current scale.

Neutral:

- This remains a ledger, not a chat transport.

### Option B: Move each thread to JSONL

Good:

- Fewer files for chatty threads.
- A thread can be read by opening one file.

Bad:

- Multiple agents posting to the same thread in separate worktrees will edit the
  same file, increasing Git conflict risk.
- Requires a migration path, validation changes, index changes, and dual-format
  compatibility.
- Makes one malformed line affect a whole thread file's operational path.

Neutral:

- JSONL remains local-first, but it is a different canonical record model from
  the rest of the ledger.

### Option C: Shared cross-worktree message store

Good:

- Could provide live-ish cross-worktree inbox behavior.

Bad:

- Contradicts ADR-0003 for V1.
- Introduces shared storage and cross-worktree locking/lifecycle complexity.
- Pulls Waystation toward chat-server behavior, a V1 non-goal.

Neutral:

- This can be revisited only if live cross-worktree coordination becomes a
  product requirement.

## Decision

Keep the current one-file-per-message JSON layout for V1 and Phase 8. Do not
migrate messages to per-thread JSONL now.

If future evidence shows real friction, create a separate migration task with
acceptance criteria for schema, validation, index rebuild, CLI/MCP/dashboard
compatibility, and a reversible migration plan.

## Consequences

Positive:

- No storage migration risk.
- Current `post`, `list`, `inbox`, validate, MCP, and dashboard behavior stays
  valid.
- Git merges should usually add distinct files instead of conflicting on a hot
  thread file.
- Message records remain consistent with Waystation's canonical JSON-record
  model.

Negative:

- Very chatty projects may accumulate many files in `.waystation/messages/`.
- Thread reads still load and filter message records.

Risks:

- Message volume may grow enough that scans become annoying.
- Mitigation: measure before migrating; SQLite indexing already provides a
  disposable acceleration path without changing canonical storage.

## Implementation Plan

Affected files or areas:

- `src/core/messages.ts`
- `src/core/validate.ts`
- `.waystation/messages/`
- `docs/roadmap.md`
- `.waystation/decisions/`

Steps:

1. Record this ADR.
2. Add a Waystation decision record for indexability.
3. Update the roadmap to link the decision.
4. Make no message storage code changes in this task.

Patterns to follow:

- Keep messages immutable.
- Continue writing through `postMessage` and the core write path.
- Use SQLite/index improvements for read performance before changing canonical
  storage.

Patterns to avoid:

- Per-thread JSONL migration without a separate task and migration plan.
- Shared message stores outside `.waystation/`.
- Live cross-worktree inbox claims in V1.

## Verification

- [ ] `waystation validate` is clean.
- [ ] Existing message post/list/inbox tests continue to pass.
- [ ] Roadmap links this decision.
- [ ] No message storage code changes are introduced by the decision task.

## Waystation Records

Related tasks:

- `task-phase8-message-storage-decision`
- `task-agent-messaging`
- `task-validate-messages`
- `task-phase6-worktree-message-scope-decision`

Related decisions:

- `.waystation/decisions/decision-message-storage-layout.json`
- `.waystation/decisions/decision-worktree-message-scope.json`

Related prompts/scopes:

- `prompt-waystation-v1`
- `scope-core`

## Links

- [ADR-0003: Worktree Message Scope](./ADR-0003-worktree-message-scope.md)
- [Roadmap Phase 8](../docs/roadmap.md)
