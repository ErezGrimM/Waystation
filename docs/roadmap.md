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

## Current State (2026-07-06)

**Runtime:** Bun 1.3.14 (local at `C:\bun`, not on PATH). Node 24 works as a
fallback. 36 tests green.

**Done:** ledger bootstrap; Bun/TS scaffold; the full CLI walking skeleton
(`task next|ready|list|show|claim|release|finish`, `brief`, `validate`,
`reindex`, `report`); YAML→JSON ledger migration; agent messaging (`message
post|list`, `inbox`, `project` channel).

**In progress:** `task-error-envelope` — the `CommandResult`/`Diagnostic`
envelope. Core landed (catalog, `validate` migrated, coded errors); two items
remain (below).

**Decisions on record:** Bun+TS stack; JSON records; dashboard-only LLM
features. **Issues:** timestamp format (fixed).

---

## Phase 1 — CLI Walking Skeleton ✅ DONE

Goal: a runnable, dogfoodable ledger CLI.
Slices: scaffold → `task next` (proves Bun+zod+bun:sqlite+JSON compose) → read
commands → mutations (write path) → validate → brief → generate.
Exit criteria (met): Waystation manages its own task list; reports are
generated, not hand-written; `validate` clean.

## Phase 2 — Coordination Primitives ⏳ IN PROGRESS

Goal: the primitives that make multi-agent coordination real.
- **Agent messaging** ✅ — async inbox, `project` channel, per-folder scope.
- **Error envelope** ⏳ (`task-error-envelope`). Remaining:
  1. Surface the `bun:sqlite`→`node:sqlite` fallback as a
     `sqlite_backend_fallback` **warning** through a `CommandResult`.
  2. Roll the envelope across the remaining read commands (`next`, `list`,
     `show`, `brief`) so they return `CommandResult` with `warnings[]` too.
Exit criteria: every command returns the envelope; every emitted code is
catalogued (coverage test already enforces this for `validate`).

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

## Phase 4 — MCP Server (deferred phase)

Goal: expose the same core over stdio for coding agents.
Scope: `get_status`, `get_next_task`, `get_task`, `claim_task`, `release_task`,
`get_brief`, `render_prompt`, `create_handoff`, `list_issues`, `create_issue`,
`record_test_run`, `post_message`, `get_inbox`, `validate_ledger` (spec §14).
Thin wrappers over core logic — no new behavior. First real task: smoke-test
`@modelcontextprotocol/sdk` on Bun (the one unverified dependency).
Out of scope: anything that isn't a thin call into existing core functions.

## Phase 5 — Local Dashboard (deferred phase)

Goal: a local web UI over the same ledger (spec §15), and the home for the
opt-in LLM features.
Scope: Hono server embedding a Vite+React SPA; read views (tasks/issues/
messages/briefs) with SSE live updates; write via the core path. **LLM
features live here only** (prompt rewrite, agent suggestion) — advisory,
human-triggered, streamed, with API keys in dashboard-only config (see
`decision-dashboard-llm-features`).
Out of scope: real-time presence/chat transport; auth beyond localhost binding.

## Phase 6 — Git & Worktree Integration (later)

Goal: read git state and support worktree-per-agent parallelism (spec §17).
Scope: detect branch/worktree, map to active claims, warn on overlapping file
hints. **Open boundary to resolve:** "chat is per project folder" means per
*checkout* — agents in separate worktrees won't see each other's messages until
merge. Decide whether that's acceptable or whether messages need a shared
location.
Out of scope: creating branches/worktrees/PRs automatically (V1 non-goal).

## Phase 7 — External Integrations (later)

GitHub Issues import/export; Graphify context enrichment for briefs (spec
§17.1, §22). All optional, never required. Out of scope: making any external
service a hard dependency.

---

## Backlog / follow-ups not yet phased

- Revisit message storage layout (one-file-per-record vs per-thread JSONL) if
  merge friction or chatty threads become real.
- Brief `--budget` tiers (small/medium/large/full) — currently accepted but
  one behavior.
- Timestamp normalization of the earlier UTC-`Z` records to local offset (the
  format is now local; old records left valid).

## Open decisions

1. Worktree vs folder scope for messaging (Phase 6).
2. When to `git init` (recommended: Phase 3, before more code accretes).
3. Whether summary.md-style hand docs stay separate from generated context
   (current answer: yes, generation never touches hand-authored docs).
