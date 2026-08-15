# ADR-0008: Equal-Priority Task Ranking Policy

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Erez
**Consulted:** OpenCode
**Related:** [`task-audit-ranking-policy`](../.waystation/tasks/task-audit-ranking-policy.json)

## Context

`task next`, `task ready`, and the dashboard "pick next task" guidance all
present actionable tasks best-first. Waystation previously ordered actionable
tasks by priority (1 first, 5 last) and then by id. The id tiebreak is
deterministic but opaque: `task-zebra` sorts after `task-anteater` with no
meaning to the human or agent choosing work.

OA-13 records that equal-priority ordering lacks an explicit product decision.
This ADR compares the realistic options and fixes the ordering. It is a
decision-only task: no new schema field is absorbed into the correctness
release, and the milestone is not blocked by it.

## Decision Drivers

- **Deterministic behavior**: the same ledger must yield the same pick order
  for in-memory and index-backed queries, on every machine.
- **Migration cost**: the tiebreak must not require rewriting records or
  expanding the schema unless user-control evidence justifies it.
- **User control**: humans and agents order work by `priority` (1–5); the
  tiebreak should feel predictable, not arbitrary.
- **Scope discipline**: a p4 nicety must not expand the released surface
  (schema, mutations, CLI, MCP, dashboard) without real evidence.

## Options Considered

### Option A: Priority, then id (status quo)

Good:

- Zero migration cost; no new field.
- Fully deterministic: `id` is unique, always present, and `localeCompare` is
  stable across runs and machines.
- Already implemented identically in-memory and via the index.

Bad:

- The tiebreak is opaque; equal-priority order is alphabetical-by-slug, which
  conveys no intent and gives no FIFO or recency semantics.
- No user control beyond the five priority levels.

### Option B: Priority, then created_at, then id

Good:

- Zero migration cost: `created_at` already exists on every task record (the
  live ledger has 69/69 tasks stamped) and is immutable.
- Meaningful, predictable semantics: among equal priorities the oldest work is
  picked first (FIFO), which suits an agent-coordination queue.
- Fully deterministic: `created_at` never changes, and `id` remains the final
  unique tiebreak for identical timestamps.
- Explicit fallback for legacy or hand-authored records missing `created_at`:
  they sort as earliest, so they never starve behind stamped records.

Bad:

- Slightly more code than Option A; a shared comparator must be reused by both
  backends.
- Timestamp resolution ties are possible in principle; `id` absorbs them.

### Option C: Optional explicit nonnegative `rank`, then created_at, then id

Good:

- Maximum user control: a finer-grained knob than the five priority levels,
  independent of creation time.

Bad:

- Highest migration cost: new schema field, migration for existing records,
  mutation paths, CLI/MCP/dashboard surface, a new index column, and a
  deterministic fallback for records without `rank`.
- Largely duplicates `priority`: priorities 1–5 already express relative
  importance, and `rank` would add a second control axis with the same job.
- Expands the just-released surface for a p4 nicety without evidence that
  priority plus creation time is insufficient in practice.

## Decision

Adopt **Option B: priority, then created_at, then id** as the canonical
ordering for actionable-task ranking, in both in-memory and index-backed
queries.

- Lower priority number first; among equal priorities, earlier `created_at`
  first; records missing `created_at` sort as earliest; `id` is the final
  unique tiebreak.
- A single shared comparator (`byPriorityThenCreatedAtThenId` in
  `src/core/tasks.ts`) is used by `nextTask`, `readyTasks`,
  `auditPromotableTasks`, and the index-backed `readyFromIndex`, so the two
  backends cannot drift.
- **Explicit `rank` is rejected at this time.** The rejection rationale: the
  five priority levels already provide the user-control axis, `created_at`
  gives equal-priority ties a meaningful deterministic order, and the schema,
  migration, and four-surface cost of `rank` is disproportionate to the
  benefit. Reconsider it only if real usage shows priority plus creation time
  insufficient.
- **No `deferred` status is added.** After the readiness correction, `todo` is
  the non-actionable backlog state; a separate status should be reconsidered
  only if real usage proves `todo` insufficient.

## Consequences

Positive:

- Equal-priority ready work is picked oldest-first, a predictable queue
  semantics for agents and humans.
- Ordering is documented and enforced identically by in-memory and index-backed
  queries through one shared comparator.
- No record migration or schema change.

Negative:

- The pick order can differ from the previous alphabetical-by-id order at equal
  priority; nothing in the current ledger has an actionable equal-priority tie
  to disrupt.

Risks:

- A hand-authored record without `created_at` sorts before stamped records;
  documented and deterministic, and `validate`/tooling always write the stamp.
- Reconsidering `rank` later would be a new, separately phased feature task,
  not a correction-release change.

## Implementation Plan

Affected files:

- `src/core/tasks.ts` — export shared `byPriorityThenCreatedAtThenId`.
- `src/index/taskIndex.ts` — store `created_at`, reuse the shared comparator.
- `test/skeleton.test.ts` — deterministic ordering tests, in-memory and index
  parity, missing-`created_at` fallback.
- `docs/operational-audit-corrections-plan.md` — record the decision outcome.
- `.waystation/decisions/decision-task-ranking-policy.json` — structured record.

Steps:

1. Replace the inline id tiebreak with the shared comparator in both backends.
2. Add the `created_at` column to the disposable index.
3. Test equal-priority ordering, the missing-`created_at` fallback, and
   in-memory/index agreement.

Patterns to follow:

- One write path, one ordering definition shared by all readers.
- Decision-only task: no schema or surface expansion.

Patterns to avoid:

- Reopening the completed correction release to add `rank` or a new status.

## Verification

- [ ] `bun test` green, including equal-priority created_at order, the
  missing-`created_at` fallback, and index/in-memory parity.
- [ ] `tsc --noEmit` and `biome check` clean.
- [ ] `waystation task next` and `task next --from-index` agree on pick order.
- [ ] ADR and `.waystation/decisions/` record exist; OA plan updated.

## Waystation Records

Related tasks:

- `task-audit-ranking-policy`

Related decisions:

- `.waystation/decisions/decision-task-ranking-policy.json`

## Links

- `docs/operational-audit-corrections-plan.md` (OA-13, "Equal-priority
  ranking" section)
- `src/core/tasks.ts`, `src/index/taskIndex.ts`