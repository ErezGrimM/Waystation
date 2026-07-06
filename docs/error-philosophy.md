# Error Handling Philosophy

## Overview

Waystation is driven far more often by a coding agent than by a human at a
prompt, and the same core logic is reached three ways — the CLI, the (future)
MCP server, and the (future) dashboard (spec §20). So errors are **structured,
first-class output with a single shape**, produced once in the core and
rendered per surface. A caller — human or automated — should always be able to
branch on `ok`, read a stable `code`, act on a `hint`, and decide retries from
`retryable`, without parsing prose.

Four principles, chosen deliberately (and two of them are corrections of a
common design that we do *not* want to inherit):

| Principle | Why |
|-----------|-----|
| **Stable codes, template messages** | Every diagnostic is a named code with a message *template* plus a structured `details` map. Dynamic values (a path, an id) go in `details`, never concatenated into the message. Codes are the contract; messages are for humans. |
| **`retryable` is code-level, never silently context-defaulted** | Whether the *same input* could ever succeed is a property of the failure class. Whether *this occurrence* is worth retrying is the caller's judgement. We express the first and refuse to fake the second. |
| **Diagnostics are arrays** | `errors[]` and `warnings[]`, not a singular `error`. Validation must report *every* problem at once, not one-fix-at-a-time. |
| **One core, one envelope** | CLI, MCP, and dashboard all wrap the same core diagnostics into the same shape (spec §12). No surface invents its own error format. |

---

## The Envelope

Every command returns a `CommandResult`:

```json
{
  "ok": false,
  "data": null,
  "errors": [
    {
      "code": "task_already_claimed",
      "message": "Task already has an active claim.",
      "details": { "task": "task-auth-login", "existing_claim": "claim-task-auth-login-codex-20260705-1005" },
      "hint": "Release the existing claim, or claim a different task.",
      "retryable": false
    }
  ],
  "warnings": []
}
```

- `ok` — `true` iff `errors` is empty. Warnings never flip `ok` to false.
- `data` — the command's payload on success (a task, a brief, a list). `null` when `ok` is false.
- `errors` / `warnings` — arrays of **Diagnostic** objects (below), most relevant first.

A **Diagnostic**:

```
code:      string   // stable, lower_snake_case, from the catalog
message:   string   // human-readable template text; no interpolated internals
details?:  object   // structured context: the ids/paths/values involved
hint?:     string   // what a caller can do about it
retryable: boolean  // could the SAME input ever succeed on retry?
```

This generalizes what the code already does: `validate` returns
`Problem[] = { level, code, message }[]` today. The envelope adds `details`,
`hint`, and `retryable`, and unifies the singular throw-based errors
(`RecordError`, `MutationError`) into the same Diagnostic shape.

---

## How It Works

### 1. Stable codes, template messages, structured details

The message is a fixed template owned by the catalog; the specifics live in
`details`. We do **not** build messages by concatenating runtime values:

```ts
// NO — ad-hoc, unstable, and can leak internals into the human string:
throw new RecordError(file, `invalid JSON: ${err.message}`);

// YES — stable code + structured context:
diag("invalid_json", { file, cause: err.message });
```

Rationale:
- **Greppable and stable** — dashboards and agents match on `code`, not on
  wording that a refactor might change.
- **Safe by default** — a path or a parser message is data in `details`, not
  spliced into a message that might be shown or logged somewhere sensitive.
- **Localizable later** — the template can be translated; `details` stay as-is.

`details` is the right home for the underlying **cause**. We keep the raw
cause (a zod issue, a `JSON.parse` message, an `fs` errno) in `details.cause`
for logs and debugging, while the `code` + `message` stay stable for callers.
Present a stable code outward; preserve the cause inward.

### 2. `retryable` means "could the same input ever succeed"

`retryable` is a property of the failure *class*, answerable by the catalog:

- `stale_lock` / `lock_contended` → `retryable: true` (transient; the ledger
  lock will free up).
- `invalid_json`, `schema_invalid`, `cycle`, `mutation_blocked` → `retryable:
  false` (the same bytes will fail identically until *changed*).

What the catalog must **not** do is pretend to know context it cannot see. A
missing file is `retryable: true` as a class (create it and retry), but whether
*this* missing file is worth retrying depends on whether it was a required
config or an optional path — that is the caller's call. So: the catalog sets
the class-level default and stops there. We do not auto-populate a
context-dependent verdict and invite callers to trust it blindly. (This is the
one place the "auto-populate everything from a matrix" pattern quietly lies —
we don't.)

### 3. Diagnostics come in arrays; validation collects everything

`validate` already returns every problem it finds in one pass — keep that
everywhere it makes sense:

- **Collect-all** for whole-ledger checks (`validate`) and any batch operation:
  report all duplicate ids, missing deps, and cycles together so the caller
  fixes them in one edit cycle.
- **Fail-fast (single diagnostic)** is acceptable for atomic single-record
  operations (`claim`, `finish`) where there is genuinely one thing wrong.

Either way the field is `errors[]` — a single failure is a one-element array,
not a different shape.

### 4. Layered protection matched to Waystation's real threats

Waystation's untrusted input is not SQL — it is **hand-edited canonical files
and concurrent local processes** (spec §12, §6.0). The layers reflect that:

1. **zod on every read** — no record enters the core unvalidated; a malformed
   record becomes a `schema_invalid` diagnostic, never a half-parsed object.
2. **Single locked, atomic write path** — all mutations go through
   `withLedgerLock` + `writeJsonAtomic` + `appendEvent` (`src/core/store.ts`).
   No surface writes records directly; this is the only door.
3. **`validate` as the guardrail for manual edits** — because humans *may*
   hand-edit files as an escape hatch, `validate` is the cross-record check
   that catches what a single-record schema cannot (duplicate ids, dangling
   references, cycles, orphaned claims, corrupt JSONL).
4. **Append-only events + rebuildable index** — the audit trail survives, and
   the SQLite index is disposable: a corrupt or stale index is never fatal, it
   is `reindex`-ed. Canonical JSON is the only source of truth.

Note what is deliberately *absent*: there is no blocklist/keyword filter as a
security control. Blocklist scanning is fragile and gives false confidence;
our guarantees come from schema validation and the single write path, not from
pattern-matching for "bad" content.

### 5. Fallbacks degrade with a warning, not a failure

Multi-strategy paths try the best option, then fall back — and each step down
emits a **warning** so `ok` stays `true` but the caller knows the result
arrived differently. Waystation's live example is the SQLite adapter
(`src/index/db.ts`): it prefers `bun:sqlite` and falls back to `node:sqlite`
under Node. A future explicit fallback should surface it:

```json
{
  "ok": true,
  "data": { "...": "..." },
  "warnings": [
    {
      "code": "sqlite_backend_fallback",
      "message": "Used the fallback SQLite backend.",
      "details": { "backend": "node:sqlite" },
      "hint": "Result is correct. Install/run under Bun for the primary backend.",
      "retryable": false
    }
  ]
}
```

---

## CLI Contract

- **Exit code** — `0` when `ok` (including warnings-only), `1` when `errors` is
  non-empty. (This is what `validate` and the mutation commands already do.)
- **`--json`** — read commands emit the full `CommandResult` as JSON. Without
  it, human text is rendered from the same object (codes/hints shown on error).
- Errors print to stderr, data to stdout, so piping stays clean.

---

## Code Catalog & Stability

- Codes are `lower_snake_case` (matching the shipped `validate` codes:
  `invalid_json`, `schema_invalid`, `duplicate_id`, `missing_dependency`,
  `cycle`, `claim_orphan`, `multiple_active_claims`, `invalid_jsonl`,
  `missing_scope`, `missing_prompt`).
- A code is a **stable contract**. Renaming or removing one is a breaking
  change: keep the old code emitting until a documented deprecation window
  passes. Splitting a code adds new ones; it does not silently repurpose an
  existing one.
- Codes group by the record/area they concern (task, claim, mutation, io,
  lock, index). Keep the catalog and this doc in sync; a coverage test should
  assert every emitted code is catalogued.

---

## Current State vs Target

Honest accounting — this doc is the target the code converges toward, not a
description of finished work:

| Piece | Today | Target |
|-------|-------|--------|
| Whole-ledger diagnostics | `validate` → `Problem[] {level, code, message}` | + `details`, `hint`, `retryable` |
| Load/parse failures | `RecordError(file, message)` (throws) | `Diagnostic{ code, details, retryable:false }` |
| Mutation failures | `MutationError(message)` (throws) | coded diagnostics (`task_already_claimed`, `no_active_claim`, `task_done`, …) |
| Command output | ad-hoc text + some `--json` payloads | uniform `CommandResult` envelope |
| Fallbacks | silent (`bun:sqlite`→`node:sqlite`) | emit a `warning` |

Converging on this is tracked as a ledger task (`task-error-envelope`). The two
adjustments to land first, because they are hardest to change once callers
depend on them: **(a)** the `CommandResult`/`Diagnostic` shape with `errors[]`
plural, and **(b)** `retryable` (code-level, never context-faked) in place of a
`recoverable` flag that pretends to know the situation.
