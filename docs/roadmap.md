# Waystation Roadmap

A descriptive, phased plan. It ties the granular ledger tasks (`.waystation/tasks/`)
into an arc with goals and exit criteria, and records what is deliberately out
of scope at each stage. It complements — does not replace — the spec
(`agentledger-spec.md`) and the ledger, which remain the source of truth.

## Method

Waystation is built as a **walking skeleton**: a thin end-to-end slice first,
then widen. Every capability is **dogfooded** — Waystation manages its own
work through its own CLI (`task claim`/`finish`, `message post`, `report`).
Each slice ships only when `bun test`, `tsc --noEmit`, `biome check`, and
`waystation validate` are all green.

Cross-cutting principles that hold across every phase:
- **Local-first, no daemon required** for CLI use.
- **JSON is canonical**; SQLite is a disposable index; Markdown is generated
  one-way for humans (never parsed back).
- **One core write path** (`src/core/store.ts`: lock + atomic write + event);
  CLI, MCP, and dashboard all go through it — never write records directly.
- **Structured, coded errors** (`docs/error-philosophy.md`).
- **Stay in the lane** (spec §3): not a full PM tool, not an agent runner, not
  a chat server, not a hosted service.

---

## Current State (2026-07-15)

**Runtime:** Bun 1.3.14 (local at `C:\bun`, not on PATH). Node 24 works as a
fallback. The ledger validates cleanly. **Version:** 0.0.3.

**V1 milestone (spec §21): COMPLETE.** `init`; JSON record read/write; events;
rebuildable SQLite index (all record types); `validate`; `task
next|ready|list|show|claim|release|finish`; `brief`; `prompt list|show|render`;
`handoff create|show`; agent messaging (`message post|list`, `inbox`, `project`
channel); `report` (STATUS + context + one-way Markdown views). Everything is
dogfooded through the CLI and version-controlled (git).

**Error handling:** the `CommandResult`/`Diagnostic` envelope is adopted across
commands with a stable code catalog and coverage test.

**Git/worktree integration:** complete. Claims record branch/worktree context,
briefs can resolve from the current git claim context, validation warns on
overlapping active claims, and dashboard/MCP surfaces git context.

**External integrations:** GitHub Issues import/export and Graphify brief
enrichment are implemented and remain optional.

**Decisions on record:** Bun+TS stack; JSON records; dashboard-only LLM
features; worktree messages are scoped to the current checkout/worktree for V1.

**Next:** Phase 9 operational hardening. UX polish is intentionally deferred to
a later phase; release packaging follows hardening.

---

## Phase 1 — CLI Walking Skeleton ✅ DONE

Goal: a runnable, dogfoodable ledger CLI.
Slices: scaffold → `task next` (proves Bun+zod+bun:sqlite+JSON compose) → read
commands → mutations (write path) → validate → brief → generate.
Exit criteria (met): Waystation manages its own task list; reports are
generated, not hand-written; `validate` clean.

## Phase 2 — Coordination Primitives ✅ DONE (2026-07-06)

Goal: the primitives that make multi-agent coordination real.
- **Agent messaging** ✅ — async inbox, `project` channel, per-folder scope.
- **Error envelope** ✅ (`task-error-envelope`) — `CommandResult`/`Diagnostic`
  with a code catalog; `validate` + read commands (`next`/`ready`/`list`/
  `show`/`brief`/`reindex`) emit the envelope; `RecordError`/`MutationError`
  carry codes; the `bun:sqlite`→`node:sqlite` fallback surfaces as a
  `sqlite_backend_fallback` warning; a coverage test enforces the catalog.

## Phase 3 — Robustness & Onboarding ✅ DONE (2026-07-06)

Goal: make the project safe to hand to another contributor/agent and hard to
corrupt. Small, high-leverage items:
- **README.md** ✅ — how to run (Bun at `C:\bun`), project + ledger layout,
  principles, the dogfood loop.
- **`git init`** ✅ — repo initialized on `main`; `.gitignore` excludes
  node_modules, `.agents`, `.claude/skills`, lockfile cruft, and the index;
  `.gitattributes` normalizes line endings.
- **`reindex` all record types** ✅ — `buildLedgerIndex` covers tasks, issues,
  claims, messages; `inbox`/thread can be served from the index.
- **Validate messages** ✅ — `validate` schema-checks messages and flags
  dangling `in_reply_to` and orphan threads.
Exit criteria (met): a fresh clone + `bun install` + README reaches a green
`bun test` and a working `waystation` without tribal knowledge.

## Phase 4 — MCP Server ✅ DONE (2026-07-06)

Goal: expose the same core over stdio for coding agents.
Scope: `get_status`, `get_next_task`, `get_task`, `claim_task`, `release_task`,
`get_brief`, `render_prompt`, `create_handoff`, `list_issues`, `create_issue`,
`post_message`, `get_inbox`, `validate_ledger` (spec §14).
Thin wrappers over core logic — no new behavior. SDK smoke-tested on Bun.

## Phase 5 — Local Dashboard ✅ DONE (2026-07-06)

Goal: a local web UI over the same ledger (spec §15).
Scope: Hono server embedding a Vite+React SPA; 7 views (Overview, Tasks,
Issues, Claims, Messages, Brief, Git); SSE live updates; writes via the core
path; reindex button; git status/diff/commit. Dark theme matching design mockup.
**LLM features deferred** (see `decision-dashboard-llm-features`).

## Phase 6 — Git & Worktree Integration ✅ DONE (2026-07-06)

Goal: read git state and support worktree-per-agent parallelism (spec §17).
Scope: detect branch/worktree, map to active claims, warn on overlapping file
hints. `waystation brief` auto-resolves task from current git claim context.
Messaging remains scoped to the current checkout/worktree for V1: agents in
separate worktrees see each other's ledger messages when records are merged, not
through a live shared inbox. See
[ADR-0003](../adr/ADR-0003-worktree-message-scope.md).

**Completed:**
- `src/core/git.ts` — `getGitState()` returns branch, worktree, status summary.
- `src/core/overlap.ts` — `activeClaimOverlaps()` detects same-scope and
  path-hint collisions between active claims.
- `src/core/gitContext.ts` — `buildGitContext()` composes git state + claim
  overlap warnings in one call.
- `brief` auto-detects task from git claim context when `--task` is omitted
  (`resolveTaskFromGitClaim`); returns coded diagnostics for no/ambiguous match.
- Claims record branch and worktree context via `claimGitContext` (derived from
  git state, overridable by the CLI).
- `validate` emits `active_claim_overlap` warnings; brief output includes
  advisory coordination notes.

**Exit criteria:**
- `waystation brief` without `--task` resolves from git claim context.
- `waystation validate` flags overlapping active claims.
- `waystation task claim` records branch/worktree context.
- Dashboard git page shows status, diff, and supports commit.
- `bun test`, `tsc --noEmit`, `biome check`, `waystation validate` all green.

## Phase 7 — External Integrations ✅ DONE (2026-07-06)

GitHub Issues import/export; Graphify context enrichment for briefs (spec
§17.1, §22). All optional, never required. Out of scope: making any external
service a hard dependency.

**Completed:**
- GitHub Issues import/export core module, CLI commands, and dashboard actions.
- Graphify context enrichment for briefs, CLI, MCP, and dashboard.
- Graphify crash/duplicate fixes so malformed graph data does not break briefs.

## Phase 8 — Release Readiness & Polish ✅ DONE (2026-07-16)

Goal: make the current feature set easier to ship, install, and hand to other
agents without stale docs or ambiguous next steps.

Completed slices:
- Reconcile generated reports/views and update hand-authored docs to match the
  completed Phase 6/7 reality.
- Rebuild and smoke-test the compiled `waystation.exe` artifact.
- Document install/distribution options for local CLI and MCP usage.
- Implement real `brief --budget` tiers instead of accepting the flag with one
  behavior.
- Evaluate whether the current one-file-per-message layout needs changes for
  multi-worktree merge friction; decision recorded in
  [ADR-0004](../adr/ADR-0004-message-storage-layout.md): keep one-file-per-message
  JSON for V1 and defer any migration until real friction appears.

Exit criteria:
- `task next` shows only intentional Phase 8 work.
- `docs/roadmap.md`, README, generated reports, and task views agree.
- `bun test`, `tsc --noEmit`, `biome check`, `waystation validate`, and the
  rebuilt binary smoke checks are green.

---

## Phase 9 — Operational Hardening

Goal: tighten the existing system before adding more user-facing surface area.
This phase is about trust: validation catches the shapes that migration and
generated artifacts can introduce, old ledger data is normalized where useful,
and generated outputs are audited for safety and correctness.

Planned slices:
- Normalize older UTC-`Z` timestamps to the current local-offset convention, or
  document a deliberate reason to leave any record unchanged.
- Audit generated Markdown/context views for escaping, stale content, and
  regeneration drift.
- Harden validation around migrated/imported records, especially ids,
  path-derived filenames, references, status mappings, and imported text that
  later appears in generated Markdown.
- Keep the migration guide aligned with the hardening rules as they land.

Out of scope:
- Dashboard/UX polish; this becomes a later dedicated UX phase.
- Installer or binary distribution polish; this follows in Phase 10.
- New hosted services or external systems beyond the current optional GitHub
  support.

Exit criteria:
- `waystation validate` catches the agreed migration/import edge cases.
- Generated reports/views can be regenerated cleanly with no unsafe Markdown
  output or unexplained drift.
- Timestamp handling is consistent, either by normalization or documented
  compatibility.
- `bun test`, `tsc --noEmit`, `biome check`, `waystation validate`, and the
  rebuilt binary smoke checks are green.

Progress:
- Legacy UTC-`Z` timestamps in early task, claim, and event records were
  normalized to equivalent `+03:00` local-offset timestamps on 2026-07-16.
- Validation now enforces filesystem-safe record ids/references and flags
  filename/body-id mismatches; GitHub import rejects malformed issue payloads
  before writing ledger records.

## Phase 10 — Release Packaging

Goal: make Waystation straightforward to install, rebuild, smoke-test, and hand
to another local agent or human after the hardening pass is complete.

Likely slices:
- Release checklist and version bump procedure.
- Fresh-clone smoke test script or documented checklist.
- Binary distribution notes and artifact naming.
- MCP launch examples for compiled and source modes.

## Phase 11 — UX Polish

Goal: improve the human-facing experience after the core behavior and release
path are stable.

Likely slices:
- Dashboard import/export affordances.
- Clearer health/warning surfaces.
- Task and issue lifecycle guidance in the UI.
- Small CLI wording improvements where diagnostics are technically correct but
  hard to act on.

---

## Backlog / follow-ups not yet phased

_none_

## Open decisions

1. Whether summary.md-style hand docs stay separate from generated context
   (current answer: yes, generation never touches hand-authored docs).
