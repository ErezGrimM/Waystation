# Waystation Context Summary

Waystation is a local-first task, issue, prompt, and handoff ledger for
coordinating humans and AI coding agents across a codebase.

It was previously called AgentLedger. Some older documents still use that
name. Treat Waystation as the product name going forward.

## Current Product Shape

Waystation coordinates work. It should answer questions like:

- What work is ready?
- Who has claimed what?
- What context applies to this task or path?
- What prompts/rules should this agent follow?
- What issues, handoffs, decisions, and test runs matter?
- What changed since the task was claimed?
- Can another agent safely start nearby work?

Waystation is not a full project manager, hosted SaaS system, CI replacement,
agent runner, or codebase-analysis engine.

## Settled Architecture

- Plain files under `.waystation/` are canonical.
- SQLite is a rebuildable local index, not the source of truth.
- Important mutations append events to `.waystation/events.jsonl`.
- CLI, dashboard, and future MCP tools must call the same core write path.
- Canonical records are JSON; SQLite is the disposable index; Markdown is
  generated one-way from JSON for humans (never parsed back).
- Agents should normally mutate state through Waystation commands or MCP tools,
  not by hand-editing JSON.
- Manual JSON edits remain supported for inspection, recovery, and
  bootstrapping.
- Mutating commands should acquire a local write lock, validate inputs, write
  canonical files, append events, and update or invalidate the SQLite index.
- Read commands should support `--json` where practical.

## Internal Graph Boundary

Waystation should keep a simple work-coordination graph:

- task dependencies
- task-to-scope relationships
- task-to-prompt relationships
- issue-to-task relationships
- claim-to-task relationships
- handoff-to-task relationships
- decision-to-scope or decision-to-task relationships
- test-run-to-task relationships
- path and symbol hints

Waystation should not keep a canonical ledger of every function, class, import,
symbol, or call edge in the codebase. That belongs to Graphify or another
codebase-analysis tool.

## Graphify Integration

Graphify is planned as an optional prompt/brief enrichment source.

Waystation should consume Graphify outputs such as:

```text
graphify-out/
  graph.json
  GRAPH_REPORT.md
  graph.html
```

Waystation should primarily read `graph.json` and may use `GRAPH_REPORT.md` for
human-facing summaries. It should not reimplement or embed Graphify's Python,
Tree-sitter, NetworkX, clustering, LLM, or vision pipeline.

Graphify context is generated, best-effort, and staleable. It depends on
Graphify's language and file-type support. Unsupported or niche languages may
have weaker structural context.

Use Graphify context to enrich briefs and prompts with related files, concepts,
call paths, dependency paths, and impact hints. Do not use it to decide task
status, claim ownership, task dependencies, or completion.

## Stack Decision

**CONFIRMED 2026-07-06: Bun + TypeScript, with JSON canonical records.**
Recorded in `.waystation/decisions/decision-implementation-stack.json` and
`decision-record-format.json`. `adr/ADR-0001` (Bun/TS) is accepted;
`adr/ADR-0002` (Go) is superseded. The Deno candidate is rejected.

Prior ADRs, for history:

- `ADR-0001` (accepted): Bun/TS for CLI, core, dashboard server, dashboard UI,
  and later MCP.
- `ADR-0002` (superseded): Go for CLI/core/dashboard API, with a Vite/React
  dashboard embedded into the Go binary.

The spike evidence below (both Deno and Bun were spiked on 2026-07-06)
supported the decision; Bun had the smoothest local dev loop and comparable
binary size, and distribution was only a secondary priority.

A Deno stack spike was run on 2026-07-06 under `spikes/deno-stack/`.

Spike result: Deno is viable enough to remain a finalist. The spike passed
task YAML loading, Zod validation, `node:sqlite` indexing, MCP SDK import and
server registration, `deno compile`, and running the compiled executable
against the current `.waystation/` files.

Deno caveats discovered:

- Deno permissions need to be explicit.
- `commander` probes color-related env vars.
- npm `yaml` probes logging env vars.
- Compiled binaries must discover the project from `Deno.cwd()` and walk upward
  to `.waystation`; `import.meta.url` points into Deno's temporary compiled
  bundle.
- The compiled Windows executable was about 96 MB in the spike because it
  embedded npm dependencies, including MCP/Hono-related transitive deps.

Deno design implication: prefer Deno-native or small dependencies where
possible, and avoid importing heavy future-phase packages into the main CLI
binary until needed.

A Bun stack spike was also run on 2026-07-06 under `spikes/bun-stack/`.

Spike result: Bun is viable enough to remain a finalist. The spike passed task
YAML loading, Zod validation, `bun:sqlite` indexing, MCP SDK import and server
registration, `bun build --compile`, and running the compiled executable
against the current `.waystation/` files.

Bun findings:

- Bun version tested: `1.3.14` on Windows x86_64.
- `bun install` worked cleanly.
- `bun:sqlite` created and queried `.waystation/index-bun-spike.sqlite`.
- The compiled executable worked from both the spike directory and repo root.
- The compile was very fast.
- Bun did not require Deno-style explicit runtime permission grants.
- The compiled Windows executable was about 99 MB, roughly comparable to the
  Deno spike's 96 MB.

Bun design implication: Bun currently has the smoothest local developer loop in
the stack spikes. Its compiled binary story works for this small test, but
binary size is not meaningfully better than Deno with the current dependency
set.

## Decision Guidelines

Choose the stack by testing the most important risks, not by arguing in the
abstract.

Prioritize these criteria:

1. Fast path to a useful V1 CLI.
2. Low friction for coding agents to modify the code.
3. Reliable local writes over plain files plus events.
4. Clean SQLite index rebuild behavior.
5. Pleasant dashboard path without compromising CLI/core design.
6. Distribution story that matches the desired adoption model.
7. Future MCP feasibility.
8. Minimal dependency and tooling surprises.

Use these tie-breakers:

- If single-binary distribution matters more than one-language iteration,
  prefer Go with embedded React.
- If fastest product discovery, shared frontend/backend types, and MCP SDK
  maturity matter more than native distribution, prefer TypeScript/Bun.
- If long-term type rigor and native performance become more important than
  early velocity, reconsider Rust, but do not choose it by default for V1.

Before accepting either ADR, run a small stack spike.

Required spike checks:

- A runnable `waystation --version`.
- Load `.waystation/tasks/*.yaml`.
- Validate at least task, scope, and prompt records.
- Append a valid JSONL event.
- Open and rebuild a SQLite index.
- Serve a minimal local dashboard page.
- Confirm the dev loop feels acceptable.
- Document packaging/distribution behavior.
- Note the likely MCP path, even if MCP is deferred.

If choosing Go, additionally verify:

- `//go:embed` serves a built Vite/React dashboard.
- Vite dev server can proxy API calls to the Go process.
- SQLite via a pure-Go driver is acceptable.
- API contracts between Go and React are explicit enough to avoid drift.

If choosing TypeScript/Bun, additionally verify:

- `bun:sqlite` works for the needed index behavior.
- `bun build --compile` is acceptable or the runtime dependency is acceptable.
- `@modelcontextprotocol/sdk` compatibility is plausible for the future MCP
  phase.

Once a stack is chosen (DONE 2026-07-06):

- [x] Mark the accepted ADR as `Accepted` (ADR-0001).
- [x] Mark the competing ADR as `Superseded` (ADR-0002).
- [x] Create `.waystation/decisions/decision-implementation-stack.json` (plus
  `decision-record-format.json` and `decision-dashboard-llm-features.json`).
- [x] Update `lessons.md` and this summary.
- [ ] Migrate the existing YAML ledger to JSON (`task-migrate-ledger-json`).
- [ ] Scaffold from `task-scaffold-cli`.

## Current Focus

Build the smallest useful CLI:

- initialize and read records
- list/show/next tasks
- claim/release/finish tasks
- append events
- validate records
- generate task briefs
- rebuild SQLite index
- generate status and compact context files

## Deferred

- dashboard beyond a minimal stack spike
- GitHub Issues sync
- worktree creation
- PR creation
- agent launching
- workflow orchestration
- TUI
