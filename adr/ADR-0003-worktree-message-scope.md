# ADR-0003: Worktree Message Scope

**Status:** Accepted
**Date:** 2026-07-06
**Deciders:** Erez
**Consulted:** Codex

## Context

Phase 6 adds Git and worktree awareness. Git can have more than one worktree
for the same repository, each checked out at a different filesystem path. In
Waystation today, the ledger lives inside the checkout as `.waystation/`, and
messages are one JSON record per file under `.waystation/messages/`.

That means two agents working in separate worktrees each write to that
worktree's local copy of the ledger. Their messages, claims, and events become
visible to each other when the branches or worktrees are merged, not instantly.

The project needed to decide whether V1 should keep this checkout-local model
or introduce a shared message/ledger location across worktrees.

## Decision Drivers

- Preserve Waystation's local-first, git-friendly storage model.
- Avoid a daemon, database server, or shared lock service for V1.
- Keep messages durable, inspectable, and mergeable as plain JSON records.
- Support worktree-per-agent workflows without pretending they are real-time.
- Keep Phase 6 focused on reading Git state and warning about likely conflicts.

## Options Considered

### Option A: Checkout-local messages and ledger records

Good:

- Matches the existing storage model.
- Keeps writes simple: each worktree writes its own files.
- Preserves normal Git merge semantics.
- Needs no daemon, shared filesystem, or cross-worktree lock.

Bad:

- Agents in separate worktrees do not see each other's messages immediately.
- Inbox state can diverge until changes are merged.
- Users need clear documentation so they do not expect live cross-worktree chat.

Neutral:

- This treats Waystation as an operational ledger, not a chat transport.

### Option B: Shared message store across worktrees

Good:

- Agents in separate worktrees could see messages immediately.
- A single inbox view across all worktrees is easier to understand at runtime.

Bad:

- Requires choosing a shared storage location and lifecycle.
- Introduces cross-worktree locking and failure modes.
- Makes portability and cleanup harder.
- Pulls Waystation toward a daemon/chat-server design, which is a V1 non-goal.

Neutral:

- Could be revisited later if real cross-worktree messaging pressure appears.

## Decision

V1 keeps messages, claims, handoffs, events, and other ledger records scoped to
the current checkout/worktree. There is no shared cross-worktree message store
in Phase 6.

Phase 6 should read Git branch/worktree state, record branch/worktree context on
claims where useful, and warn about likely overlap. It should also document that
cross-worktree messages meet through Git merges, not through live shared inboxes.

## Consequences

Positive:

- Phase 6 can proceed without introducing shared storage or a daemon.
- Existing JSON-record storage and merge behavior remain intact.
- Worktree integration stays aligned with the V1 non-goal of not becoming chat
  infrastructure.

Negative:

- Separate worktrees can temporarily disagree about messages and claims.
- Agents may need to merge or inspect another worktree to see its latest ledger
  records.

Risks:

- Users may expect a global inbox across worktrees.
- Mitigation: dashboard, CLI, and docs should label the current worktree and
  make checkout-local behavior explicit.

## Implementation Plan

Affected files or areas:

- `docs/roadmap.md`
- `src/core/messages.ts`
- `src/core/mutate.ts`
- `src/core/brief.ts`
- `src/dashboard/`
- `src/mcp/server.ts`

Steps:

1. Remove the Phase 6 open boundary from the roadmap and link this ADR.
2. Add Git state detection and worktree path reporting.
3. Record branch/worktree context on claims when available.
4. Show checkout/worktree context in CLI, MCP, dashboard, and briefs.
5. Document that inboxes are checkout-local in V1.

Patterns to follow:

- Shared core logic with thin CLI/MCP/dashboard wrappers.
- Plain JSON records as canonical state.
- Advisory warnings instead of blocking cross-worktree work.

Patterns to avoid:

- Shared mutable message stores outside `.waystation/`.
- Background daemons.
- Automatic branch/worktree/PR creation in V1.

## Verification

- [ ] `docs/roadmap.md` links this ADR from Phase 6.
- [ ] Phase 6 git-state surfaces identify the current worktree/checkout.
- [ ] Tests cover non-git and git-worktree-aware behavior where feasible.
- [ ] `waystation validate` is clean.

## Waystation Records

Related tasks:

- `task-phase6-worktree-message-scope-decision`
- `task-git-state-core`
- `task-claim-git-context`

Related decisions:

- `.waystation/decisions/decision-worktree-message-scope.json`

Related prompts/scopes:

- `prompt-waystation-v1`
- `scope-git`

## Links

- [Roadmap Phase 6](../docs/roadmap.md)
- [AgentLedger spec §17](../agentledger-spec.md#17-git-and-worktree-behavior)
