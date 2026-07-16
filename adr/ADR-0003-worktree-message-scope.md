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

That means a normal invocation in a worktree writes to that checkout's local
copy of the ledger. For coordinated work, an agent may deliberately select one
other checkout's ledger as the shared coordination point.

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

### Option B: Opt-in shared ledger across worktrees

Good:

- Agents in separate worktrees could see messages immediately.
- A single inbox view across all worktrees is easier to understand at runtime.

Bad:

- Requires an explicit root selection and clear disclosure of the selected
  ledger.
- Introduces cross-worktree locking and failure modes that the file lock must
  handle.
- Must keep the caller's branch/worktree context distinct from the selected
  ledger location.

Neutral:

- Could be revisited later if real cross-worktree messaging pressure appears.

## Decision

Waystation defaults to checkout-local coordination: it discovers `.waystation`
upward from the caller. Shared coordination is opt-in through `--root <path>`
or `WAYSTATION_ROOT`. Root selection has stable precedence: explicit `--root`,
then `WAYSTATION_ROOT`, then caller discovery. There is no automatic discovery
of a main worktree or other sibling checkout.

All surfaces disclose the selected ledger root. Mutations lock and write that
ledger, while claims record Git branch/worktree from the calling checkout. This
keeps a shared ledger useful without treating it as a daemon or automatic
cross-worktree transport.

## Consequences

Positive:

- Checkout-local use remains zero-configuration.
- Agents that intentionally share a ledger see claims and messages immediately.
- A single ledger-wide lock prevents two worktrees from claiming the same task.

Negative:

- Shared mode depends on a reachable common filesystem path.
- Users must opt in deliberately; selecting a missing root is an error rather
  than a fallback to a different ledger.

Risks:

- Users may accidentally believe `--root` changes their Git identity.
- Mitigation: claims preserve and display the caller worktree separately from
  the ledger root.

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
4. Resolve ledger roots consistently in CLI, MCP, and dashboard, and disclose
   the selected root.
5. Record caller branch/worktree context on shared-ledger claims.
6. Document checkout-local default and opt-in shared coordination.

Patterns to follow:

- Shared core logic with thin CLI/MCP/dashboard wrappers.
- Plain JSON records as canonical state.
- Advisory warnings instead of blocking cross-worktree work.

Patterns to avoid:

- Automatic discovery of another worktree's ledger or a presumed main checkout.
- Background daemons.
- Automatic branch/worktree/PR creation in V1.

## Verification

- [ ] `docs/roadmap.md` links this ADR from Phase 6.
- [ ] Phase 6 git-state surfaces identify the current worktree/checkout.
- [ ] Tests cover resolver precedence, missing-ledger errors, and concurrent
  shared-ledger claims.
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
