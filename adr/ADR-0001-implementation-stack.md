# ADR-0001: Implementation Stack for Waystation

**Status:** Accepted (2026-07-06) — runtime refined to **Bun** (not plain Node); canonical records are **JSON** (see [ADR-0003 note below](#amendment-2026-07-06) / `.waystation/decisions/decision-record-format.json`).
**Date:** 2026-07-05
**Deciders:** Erez (project owner)

> **Amendment (2026-07-06):** Accepted with two refinements decided after this ADR was drafted: (1) the runtime is **Bun**, not plain Node — see the updated stack in `lessons.md` and `.waystation/decisions/decision-implementation-stack.json`; (2) canonical records are **JSON**, not YAML — see `.waystation/decisions/decision-record-format.json`, which drops `yaml` and `gray-matter`. The TypeScript/JS direction chosen here stands; Deno and Go (ADR-0002) were the finalists considered and rejected. Both a Deno and a Bun spike were run on 2026-07-06 (see `spikes/` and `.waystation/context/summary.md`).

## Context

Waystation (formerly AgentLedger) is a local-first coordination ledger for
human/AI coding workflows: CLI first, local dashboard early, MCP server later.
Canonical state is plain YAML/Markdown files plus an append-only event log;
SQLite is a disposable query index, not the source of truth (per
[agentledger-spec.md](../agentledger-spec.md) §5–§9, §20).

The project's own docs (lessons.md, prompt-waystation-v1.yaml,
.waystation/context/summary.md, task-scaffold-ts-cli.yaml) already assert
"Decision: TypeScript/Node" — but that was a lessons-doc conclusion, not a
decision you'd actually signed off on. This ADR treats the stack as open and
decides it explicitly, using the constraints you just confirmed:

- **Distribution:** single-binary is *somewhat* important — a Node/runtime
  dependency is acceptable if it buys real iteration speed, but shouldn't be
  dismissed as a non-concern.
- **Priority for the first 4–6 weeks:** iteration speed over long-term
  reliability/type-rigor.
- **Sequencing:** CLI + dashboard first; MCP server comes later (reordered
  from the spec's original "MCP is important early" framing).
- **UI trajectory:** you expect to want a *better* interface later — richer
  interactivity (live filtering, drag-drop, real-time updates), not just more
  CRUD screens. This rules out a "simple server-rendered dashboard forever"
  assumption and was the deciding factor over Go (see Option B and the Go+htmx
  counter-argument below).

## Decision

Build Waystation V1 in **TypeScript / Node 22+**, per the "likely stack" in
agentledger-spec.md §23 and lessons.md — commander (or clipanion) for the CLI,
`yaml` + `gray-matter` for records, `better-sqlite3`/`node:sqlite` for the
index, Hono for the local dashboard server, and the MCP SDK added later when
that phase starts.

## Options Considered

### Option A: TypeScript / Node

| Dimension | Assessment |
|---|---|
| Complexity | Low-medium — mainstream tooling, but Node packaging/versioning adds moving parts |
| Cost | Low — largest library ecosystem, least code to write per feature |
| Scalability | Fine for a local-first single-user tool; not a factor here |
| Team familiarity | Assume high — matches the AI-coding-tool ecosystem this targets |
| Distribution | Weak fit for "somewhat important" single-binary goal — needs Node installed, or a bundler (`pkg`/`bun build`/`deno compile`) to fake single-binary |
| Dashboard fit | Strong — same language for server + UI, Vite/React/Preact readily available |
| MCP fit | Strong — official `@modelcontextprotocol/sdk` is TS-native, but since MCP is deferred this is less decisive now |

**Pros:** Fastest path to a working CLI + dashboard; one language across CLI/server/UI; largest ecosystem for YAML/Markdown/frontmatter parsing; directly reusable reference implementations (Backlog.md, Taskmaster) are TS.
**Cons:** Distribution story is the weakest of the three; runtime/dependency drift risk; no memory-safety or type-rigor guarantees as strong as Rust.

### Option B: Go

| Dimension | Assessment |
|---|---|
| Complexity | Low — simple, few footguns, easy for contributors and agents to modify |
| Cost | Medium — smaller ecosystem than TS, more to hand-write (e.g. no ready-made dashboard framework) |
| Scalability | N/A (local tool) |
| Team familiarity | Assume lower than TS given the stated priority is speed, which usually tracks existing familiarity |
| Distribution | Strong — true single static binary, trivial cross-compilation |
| Dashboard fit | Weak — `html/template` + `net/http` works but is noticeably slower to iterate on UI than a JS framework |
| MCP fit | Workable via community SDKs, but less mature than the TS SDK; irrelevant near-term since MCP is deferred |

**Pros:** Best distribution story if you ever need agents/CI to drop in one file; simple mental model; good long-term maintenance tool. Note: a Go+htmx/templ dashboard (server-rendered fragments, no SPA build step) narrows the "dashboard is slow to build" gap for simple CRUD views — this is a real, fast pattern, not a weak fallback.
**Cons:** The htmx pattern has a ceiling. You've said you'll want a *better* interface later — live filtering, drag-drop kanban, real-time updates. Go+htmx can approximate some of this, but pushes past that ceiling means bolting a JS SPA onto a Go backend anyway, i.e. paying for two stacks instead of one. That eventual rewrite cost is the real argument against Go here, not raw initial dashboard speed.

### Option C: Rust

| Dimension | Assessment |
|---|---|
| Complexity | High — strong types pay off later, cost iteration speed now |
| Cost | Highest — most boilerplate per feature, slowest to reach a usable V1 |
| Scalability | N/A (local tool) |
| Team familiarity | Assume lowest, and steepest learning curve if not already fluent |
| Distribution | Best — single binary, fast startup, no runtime |
| Dashboard fit | Weak-medium — `axum` + `askama` is workable but is server-rendered HTML, not a fast UI iteration loop |
| MCP fit | Workable, immature ecosystem; irrelevant near-term |

**Pros:** Best long-term reliability and validation-heavy correctness; ideal if Waystation were staying CLI-only forever.
**Cons:** Directly opposes your stated priority (speed over rigor) and your near-term goal (dashboard soon) — this is the slowest option for both of the things you said matter most right now.

## Trade-off Analysis

Your three answers point the same direction:

- "Iteration speed over reliability" rules out Rust outright — it optimizes for exactly what you said matters less right now.
- "Dashboard matters soon, MCP later" reorders the original spec's TS justification (which leaned on MCP-SDK fit) onto dashboard fit instead — and TS is *still* the strongest option there, arguably more so, since Go/Rust dashboard iteration is markedly slower than TS.
- "Distribution somewhat important, not critical" is the one point against TS, and it's a real, if bounded, cost — not a blocker. It shows up in Consequences below as something to actively mitigate rather than ignore.

Go would be the pick if the dashboard were deferred instead of MCP (Go's actual strength lines up with "CLI + MCP now, UI later" — the inverse of your sequencing). Since your sequencing is CLI + dashboard now, Go's main advantage (distribution) doesn't offset its main weakness (UI iteration speed) for the phase that matters most.

Go+htmx was considered as a closer contender than the initial pass gave it credit for: it gets you real single-binary distribution and is fast enough to build a first CRUD dashboard. But "I will want a better interface in the future" is the deciding fact — it means the UI destination isn't a handful of server-rendered tables, it's something with real client-side interactivity. Hitting that with Go means adding a JS frontend later anyway, so starting in TS avoids a stack-split rewrite rather than avoiding slow dashboard iteration per se.

## Consequences

- Faster path to a usable CLI + local dashboard; can start building immediately using the stack lessons.md already scoped out.
- Distribution stays a Node dependency for now. Mitigate later with `pkg`, `bun build --compile`, or `deno compile` if single-binary becomes a harder requirement — revisit this ADR if that requirement escalates from "somewhat" to "critical."
- MCP server work is deferred; when it starts, `@modelcontextprotocol/sdk` (TS-native) is a strong fit, so this decision doesn't need revisiting for that reason.
- Because canonical state is plain YAML/JSONL files (spec §5, §20), the core ledger logic stays portable — a future rewrite of the CLI/dashboard layer in Go or Rust (if distribution needs escalate) would not require a data-format migration.
- Update [lessons.md](../lessons.md) and [.waystation/context/summary.md](../.waystation/context/summary.md) to mark the TS decision as **confirmed** (2026-07-05) rather than provisional, and update your memory record accordingly.

## Action Items

1. [ ] Confirm this ADR, then update `.waystation/decisions/` with a `decision-implementation-stack.yaml` record per the spec's §6.8 format.
2. [ ] Update lessons.md / summary.md to state the decision is confirmed, not assumed.
3. [ ] Scaffold the TS CLI per task-scaffold-ts-cli.yaml (or task-scaffold-cli.yaml if it's been generalized).
4. [ ] Revisit distribution strategy (`pkg`/`bun compile`) once dashboard + CLI V1 are usable, if single-binary needs become critical.
