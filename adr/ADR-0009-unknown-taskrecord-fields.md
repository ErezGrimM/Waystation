# ADR-0009: Unknown TaskRecord Fields Are Preserved

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Erez
**Consulted:** OpenCode
**Related:** [`task-record-unknown-fields`](../.waystation/tasks/task-record-unknown-fields.json)

## Context

The 2026-08-15 complete code audit found that `TaskRecord` was a plain
`z.object` with no `.passthrough()` (src/core/schema.ts:62), unlike
`IssueRecord` which uses `.passthrough()` (src/core/schema.ts:85-107).
`loadTaskFiles` (src/core/records.ts:45) validated each record on read with
`TaskRecordSchema.safeParse`, and the schema stripped unknown fields. As a
result, any extra field on a hand-authored or future task record was silently
dropped the first time a mutation wrote the task back to disk — data loss with
no warning.

This matters because task records are the ledger's primary record type and are
meant to be hand-authored and extended over time. Extra fields are legitimate
forward-compatibility surface: an agent or tool may add context to a record
before a schema revision absorbs it.

## Decision Drivers

- **No silent data loss**: a field present on disk must not vanish because it
  is not in today's schema.
- **Forward compatibility**: unknown fields from newer tooling must survive
  round-trips until the schema catches up.
- **Consistency**: `IssueRecord` already preserves unknown fields; the two
  sibling record types should not diverge without reason.
- **Strictness where it matters**: validation must still reject malformed
  *known* fields and unsafe ids.

## Options Considered

### Option A: `.passthrough()` — preserve unknown fields

Good:

- No data loss: unknown fields survive every mutation round-trip.
- Matches `IssueRecord`, so both record types behave alike.
- Cost-free forward compatibility for hand-authored and future records.

Bad:

- A typo in a field name (e.g. `dependancies`) is silently carried instead of
  flagged. Mitigation: `validate` and tooling still flag malformed *known*
  fields, and the model stays strict on every field it declares.

### Option B: Strip unknown fields (status quo)

Good:

- Typo'd field names never leak into canonical records.

Bad:

- Silent data loss on the first mutation, which is worse than a typo surviving.
- Diverges from `IssueRecord` behavior without a documented reason.

### Option C: Reject unknown fields with a validate warning

Good:

- Surfaces typos immediately.

Bad:

- Breaks every hand-authored record that already carries extra fields; forces a
  migration and makes the ledger brittle to forward-compatible additions.

## Decision

Adopt **Option A**: `TaskRecord` uses `.passthrough()`, preserving unknown
fields on read and through every mutation. This matches `IssueRecord` and
guarantees no field is ever silently dropped by a schema round-trip.

- The schema remains strict on every declared field (types, ids, timestamps).
- Unknown fields are preserved as-is, not normalized.
- No record migration is required: existing records have no unknown fields, and
  the change only affects records that do.

## Consequences

Positive:

- Extra fields survive mutation round-trips; no silent data loss.
- `TaskRecord` and `IssueRecord` behave consistently.
- Forward-compatible: newer tooling can write richer records safely.

Negative:

- A misspelled unknown field is carried along instead of being rejected.
  Mitigated by validate checks on known fields and the documented schema being
  the authoritative shape.

Risks:

- A record with a maliciously large unknown payload could bloat the ledger.
  Low risk; records are already size-unbounded in `description`/`notes`.

## Implementation Plan

Affected files:

- `src/core/schema.ts` — add `.passthrough()` to the `TaskRecord` object schema.
- `test/skeleton.test.ts` — round-trip test: an unknown field survives a
  `setTaskStatus` mutation and a subsequent reload.
- `adr/ADR-0009-unknown-taskrecord-fields.md` — this record.
- `.waystation/decisions/decision-record-unknown-fields.json` — structured record.

Steps:

1. Wrap the `TaskRecord` object schema in `.passthrough()`.
2. Add the round-trip test.
3. Create this ADR and the decision record.

Patterns to follow:

- `.passthrough()` on the schema so mutations that spread the validated record
  (`{ ...task, ...patch }`) keep unknown fields.
- Strict validation on every declared field.

Patterns to avoid:

- Re-adding unknown fields in mutation code; the schema-level passthrough
  handles it in one place.

## Verification

- [x] `bun test` green, including the round-trip passthrough test.
- [x] `tsc --noEmit` and `biome check` clean.
- [x] ADR and `.waystation/decisions/decision-record-unknown-fields.json` exist.

## Waystation Records

Related tasks:

- `task-record-unknown-fields`

Related decisions:

- `.waystation/decisions/decision-record-unknown-fields.json`

## Links

- `src/core/schema.ts`, `src/core/records.ts`, `test/skeleton.test.ts`