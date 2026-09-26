# Git/Hermes contract freeze (W00)

Deliverable of `task-w00-contract-freeze`. This file freezes **names and pins** so parallel work
packages implement identical interfaces. Semantics stay in the plan
(`docs/waystation-git-hermes-implementation-plan.md`), which remains the single implementation
specification; every row below cites the plan section that owns its meaning. Field names marked
*(chosen here)* are not written literally in the plan — they are fixed at this point so no package
invents its own spelling.

## 1. Pinned baseline

| Authority | Value | Verified by |
| --- | --- | --- |
| Waystation baseline commit | `9907de9` (`main`, 13 commits ahead of `origin/main`) | `git log --oneline -1`, `git status -sb` |
| Waystation plan doc baseline | `baseline recorded 2026-09-26` (plan §16) | plan §16 |
| Hermes install stamp | `59004a62356f3a4697ab0fe8ad5086d2b405e2a6`, `0.21.5+2168.g59004a6`, built `2026-09-25T13:55:07Z`, `dirty: false` | `apps/desktop/release/win-unpacked/resources/install-stamp.json`, repo-root `install-stamp.json` |
| Hermes adjacent checkout | `59004a62356f3a4697ab0fe8ad5086d2b405e2a6`, `v0.21.4+canary.20260925T065930Z-24-g59004a6235` | `git rev-parse HEAD`, `git describe --tags` |
| Stamp vs checkout drift | `0` commits | `git rev-list --count <stamp>..HEAD` |
| Test baseline | `283 pass / 1 fail` (the failure is the compiled-dashboard case needing `src/dashboard/client/dist`) | plan §16; build the dashboard before treating that case as meaningful |
| On-disk `waystation.exe` | dated `2026-08-28`, older than source, git-ignored | plan §16; compiled acceptance needs a fresh `bun run build` |

The adjacent Hermes checkout is **not** a stale-mismatch case: the stamp commit and the checkout
commit are identical at the time of this freeze.

## 2. Frozen interfaces

### 2.1 `WorkerContext` — plan §4.2 (owner W06, literal)

```ts
interface WorkerContext {
  binding_id: string;
  binding_generation: number;
  expected_ledger_root: string;
  caller_worktree: string; // absolute local path
}
```

### 2.2 `InvocationContext` — plan §4.1 (owner W02, immutable, one per call)

The plan fixes the type name and its three contents; the spellings are frozen here:

```ts
interface InvocationContext {
  ledgerRoot: string;          // canonical destination ledger (readonly)
  callerDir: string | null;    // caller directory or worktree, when available
  bindingId: string | null;    // optional adapter binding identity
}
```

`process.cwd` and process-global environment are never mutated for one call, and an evidence path
never changes the ledger or the reverse (plan §4.1).

### 2.3 `CommitEvidence` — plan §6 (owner W04, literal)

```ts
interface CommitEvidence {
  schema_version: 1;
  entries: Array<{
    source_id: string;
    source_common_dir: string;
    object_format: "sha1" | "sha256";
    oid: string;
    aliases: string[];           // original refs verified to mean this object
    message: string;             // original decoded full message, no parser normalization
    encoding?: string;
    raw_message_base64?: string; // only where needed for lossless retention
    observed_at: string;
    observed_by: string;
    source_worktree: string | null;
  }>;
}
```

Field name on the record: `TaskRecord.commit_evidence` (optional, versioned, never materialized by
unrelated reads). `TaskRecord.commits` stays an ordered string array (plan §6).

### 2.4 `ProjectRegistration` — plan §11.2 (owner W08, literal)

```ts
interface ProjectRegistration {
  key: string;                // generated stable local identity
  label: string;
  ledger_root: string;        // canonical destination
  mcp_server: string;         // profile's explicit project-bound entry
  revision: number;
  state: "active" | "retired";
}
```

Stored through Hermes plugin profile-scoped state (`ctx.state`), never in `.waystation` and never in
browser storage as an authoritative list (plan §11.2).

### 2.5 Trailer keys — plan §5.3 (owner W03)

- `Waystation-Task` — matched with ASCII case-insensitivity; the task ID value stays an exact,
  case-sensitive RecordId.
- `Waystation-Close` — rejected inside a trailer block; the command's close flag is the only close
  instruction.
- Exactly one `Waystation-Task` when present; duplicates fail even with matching values.

### 2.6 Diagnostics (owner W06 for the catalog; plan §14)

New or reused codes this feature must use rather than invent synonyms — wave 1 needs only the
persistence and Git families: `lock_contended`, `mutation_intent_invalid`, `ledger_not_found`,
`git_not_repository`, `git_command_failed`, `unexpected_error`. The reconcile/transfer/read families
are enumerated in `task-w06d-diagnostics-contract`; no package adds a code to `src/core/result.ts`
without that record.

### 2.7 Events — owner W04

Business event names (`claim.released`, `task.claimed`, `task.claim_transferred`, the reconciliation
and transfer audit events) are frozen in `task-w04b-reconcile-core` and `task-w04d-transfer`. Wave 1
freezes only the *intent* structure: mutation ID plus an ordinal/event identity per expected event
(plan §9.2).

## 3. Wave-1 file ownership

One writer per file. A package that needs a change in another package's file posts a message and
waits; it does not edit across the boundary (plan §15, "shared-file changes are serialized").

| Package | Sole writer of | May not touch |
| --- | --- | --- |
| W01 (`task-w01a…d`) | `src/core/store.ts`, the `ClaimRecord` passthrough line in `src/core/schema.ts`, persistence tests | `src/core/git.ts`, `src/core/paths.ts`, `integrations/hermes/**` |
| W02 (`task-w02a…d`) | `src/core/git.ts`, `src/core/paths.ts`, Git/context modules and their tests | `src/core/store.ts`, `src/core/schema.ts`, `integrations/hermes/**` |
| W03 + W08a | the parser module and its fixtures; `integrations/hermes/**` | `src/core/store.ts`, `src/core/schema.ts`, `src/core/git.ts`, `src/core/paths.ts` |

Decision recorded here (resolves the plan §6/§15 sequencing ambiguity): the `ClaimRecord`
unknown-field passthrough lands in **W01** (it owns the preservation behavior in the shared record
path), so `task-w04a-additive-schema` must not start before `task-w01d-record-round-trip` is done,
and W04a then adds only `commit_evidence`.

## 4. Verification protocol for every package

```bash
bun run dashboard:build     # only if src/dashboard/client/dist is missing
bun test
bun run typecheck
bun run check
```

- Never exercise the live ledger: use `tmp` fixture ledgers and repositories, and clean up fixture
  roots.
- The canonical ledger (`.waystation/`) is coordinator-owned during parallel work. Packages do not
  claim, message, or commit ledger files; the coordinator serializes ledger bookkeeping (plan §17.2).
- Commit on your own branch, never on `main`, and never push.
- A commit cannot contain its own hash; the coordinator attaches evidence and closes records.

## 5. Wave-1 assignment

| Agent | Records | Focus |
| --- | --- | --- |
| A | `task-w01a-lock-acquisition-split`, `task-w01b-intent-v2`, `task-w01c-recovery-v1-migration`, `task-w01d-record-round-trip` | persistence hardening and recovery (critical path) |
| B | `task-w02a-process-adapter`, `task-w02b-object-resolution`, `task-w02c-source-identity`, `task-w02d-context-helpers` | portable Git inspection, source identity, context helpers |
| C | `task-w03-trailer-parser`, `task-w08a-registry-foundation` | trailer grammar; registry and package foundation |

## 6. Gates that remain unproven (do not assume)

Recorded by the audit (`docs/audit-2026-09-26-waystation-git-hermes-plan.md`) and still unverified at
this pin: stability/isolation of host-supplied `session_id`/`task_id` for plugin tool handlers;
loading a half-native package with `plugin_api.py` at runtime; routing N MCP servers through
`ctx.call_mcp`. These belong to W07/W08 assembly and are not prerequisites of wave 1, but no package
may claim them as established.
