# ADR-0010: Project-Declared Main-Worktree Ledger Root

**Status:** Accepted
**Date:** 2026-10-10
**Deciders:** Erez
**Consulted:** Claude
**Amends:** [ADR-0003](./ADR-0003-worktree-message-scope.md) (root selection only)
**Related:** [`task-shared-ledger-main-worktree`](../.waystation/tasks/task-shared-ledger-main-worktree.json), [`task-guard-branch-ledger-commits`](../.waystation/tasks/task-guard-branch-ledger-commits.json)

## Context

`.waystation/` is tracked in Git, so every linked worktree carries its own copy.
Under ADR-0003, upward discovery from a worktree selects that copy. Shared
coordination requires each agent to set `WAYSTATION_ROOT` or pass `--root`.

In practice agents are started in worktrees by tools that do not know about
Waystation. One agent that forgets the variable silently writes claims,
messages and status changes into a branch-local snapshot that no other agent
reads. The failure is invisible until the branch is merged, at which point
ADR-0003 already forbids merging that snapshot.

## Decision Drivers

- Make the shared ledger the path of least resistance in worktree-per-agent
  projects.
- Keep ADR-0003's guarantees: explicit, disclosed root selection; a missing
  root is an error, never a fallback.
- No daemon, no new storage location, no change for projects that do not opt in.

## Options Considered

### Option A: Keep per-agent opt-in (status quo)

Good: no change. Bad: fails silently whenever one agent is misconfigured.

### Option B: Always redirect linked worktrees to the main worktree

Good: zero configuration. Bad: changes behavior for every existing project and
presumes a main checkout, which ADR-0003 explicitly rejected.

### Option C: Project-declared redirect

The ledger's own `config.json` declares `git.ledger_root: "main_worktree"`.
Because the config is tracked, every worktree created from that history
inherits the declaration.

Good: explicit and reviewable; one setting fixes every agent. Bad: relies on
Git to locate the main worktree; bare repositories cannot use it.

## Decision

Adopt Option C. `git.ledger_root` accepts `"checkout"` (default, ADR-0003
behavior) or `"main_worktree"`. Root precedence stays `--root`, then
`WAYSTATION_ROOT`, then discovery; only the discovery step can redirect.

When the discovered ledger declares `main_worktree` and sits in a linked
worktree, the resolver selects the same relative location in the main worktree
(first entry of `git worktree list --porcelain`). It fails with
`ledger_not_found` when the main worktree has no ledger there, when the
repository is bare, or when the value is not a known mode. Outside Git the
discovered ledger is used unchanged.

This amends ADR-0003's "no automatic discovery of a presumed main checkout"
rule for projects that declare it. All other ADR-0003 rules stand: claims
record the caller's branch and worktree, and feature branches do not merge
`.waystation/` snapshots.

## Consequences

Positive:

- Agents in declared projects share one ledger with no per-agent setup.
- Misspelled or unsatisfiable declarations fail loudly.

Negative:

- Each discovery in a declared project runs two Git reads.
- `init --force` rewrites `config.json`; the scaffold now writes
  `ledger_root: "checkout"`, so a re-init resets the declaration.

## Implementation Plan

- `src/core/paths.ts`: redirect inside `resolveLedgerRoot` discovery.
- `src/core/schema.ts`: `LedgerRootMode` and `ProjectConfig.git.ledger_root`.
- `src/core/init.ts`: scaffold the default explicitly.
- `README.md`, `docs/mcp.md`: document the setting.
- Follow-up: `task-guard-branch-ledger-commits` enforces that branch-local
  ledger edits are not committed.

## Verification

- [x] `test/shared-ledger-root.test.ts` covers redirect, subdirectory mapping,
  default mode, precedence, missing ledger, unknown mode and non-Git ledgers.
- [x] `bun test`, typecheck, biome check and `waystation validate` are clean.
