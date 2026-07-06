# Waystation Research Lessons

Waystation is the new name for AgentLedger. This file captures lessons from
adjacent tools and the current stack recommendation for the first
implementation.

## Core Stack Recommendation

**Status: CONFIRMED 2026-07-06 — Bun + TypeScript.** Recorded in
`.waystation/decisions/decision-implementation-stack.json`. Deno and Go were
serious contenders and rejected. See agentledger-spec.md §23 and `adr/ADR-0001`
(accepted) / `adr/ADR-0002` (superseded).

Confirmed V1 stack:

```text
Bun (runtime) — built-in SQLite (bun:sqlite), built-in test runner, no build
  step for TS, and `bun build --compile` as a single-binary backstop
commander — CLI framework
zod v4 — schema authority for all records (validate on read, serialize on write)
bun:sqlite — rebuildable query index (§9), zero extra dependency
Hono — local dashboard server; SSE support for live ledger updates (§15) and
  for streaming dashboard-only LLM prompt-rewrite / agent-suggestion features
Vite + React — dashboard frontend; React chosen over Preact/Solid for
  ecosystem depth (drag-drop kanban, inline-editable tables) since a richer
  dashboard is an explicit future goal
TanStack Query — dashboard data fetching/streaming
@modelcontextprotocol/sdk — MCP server, deferred phase (CLI + dashboard come
  first); confirmed to run on Bun per the MCP TS SDK docs
proper-lockfile — write safety for concurrent local access (§12)
bun:test — testing (built in)
Biome — lint + format in one tool
```

Dropped from the earlier draft: `yaml` and `gray-matter` — canonical records
are JSON (see decision-record-format.json), so no YAML/frontmatter parser is
needed. Node 22+ (with `node:sqlite` and Vitest) remains a fallback only if a
Bun-specific incompatibility surfaces.

Storage model (JSON canonical, Markdown generated one-way):

```text
.waystation/
  config.json
  tasks/*.json
  issues/*.json
  prompts/*.json
  scopes/*.json
  claims/*.json
  handoffs/*.json
  decisions/*.json
  events.jsonl
  index.sqlite
  reports/STATUS.md
  views/**/*.md   (generated one-way from JSON, read-only)
  context/*.md    (generated)
```

Canonical state is JSON files. SQLite is a rebuildable cache and query index,
not the source of truth. Markdown is generated from JSON for human reading and
is never parsed back.

## Why TypeScript First

Waystation's hardest early problems are schema iteration, CLI ergonomics, MCP
support, local dashboard work, markdown/frontmatter handling, and agent
compatibility. TypeScript/Node is strongest for those.

Reasons to choose TypeScript now:

- Fastest iteration for CLI plus MCP plus dashboard.
- Natural fit for `@modelcontextprotocol/sdk`.
- Easy adoption through `npx`, `pnpm dlx`, or project-local installs.
- Strong ecosystem for Markdown, YAML, validation, local web servers, and
  front-end UI.
- Existing adjacent tools prove this path works for AI-agent task tooling.

Reasons not to start with Rust:

- Rust is excellent for a polished long-term single binary, but it slows early
  product iteration.
- Dashboard and MCP work are easier to iterate in TypeScript.
- Waystation does not initially need systems-level performance.

Reasons not to start with Go:

- Go is a good static CLI choice, and Beads proves it can work well.
- TypeScript still looks better for Waystation because MCP, prompt rendering,
  generated context views, and a local dashboard are central to the product.

## Similar Projects

### Beads / `bd`

Source: <https://gastownhall.github.io/beads/> and
<https://github.com/gastownhall/beads>

What it is:

- AI-native issue tracker for coding agents.
- Dependency-aware work graph.
- Agent-friendly CLI with JSON output.
- Uses Dolt-backed storage.
- Written mostly in Go.

Useful lessons:

- `ready` work discovery is essential.
- Dependency relationships should be first-class.
- Every read command should support JSON output.
- Agent onboarding commands are valuable.
- Work tracking should discourage ad hoc TODO files.

What to avoid or defer:

- Dolt is powerful but heavier than Waystation needs in V1.
- Waystation should keep canonical state as inspectable files and use SQLite as
  a disposable index.

Code-saving potential: medium. Borrow concepts and command behavior, not the
storage architecture.

### Backlog.md

Source: <https://github.com/MrLesk/Backlog.md/>

What it is:

- Markdown-native task manager and Kanban visualizer.
- Local-first, no account or server required.
- CLI, MCP integration, and local browser UI.
- TypeScript/Bun/React stack.
- Uses libraries such as `commander`, `gray-matter`,
  `@modelcontextprotocol/sdk`, `proper-lockfile`, React, and Tailwind.

Useful lessons:

- Markdown plus YAML frontmatter is a strong human/agent record format.
- Local browser UI can be layered on top of the same file-backed core.
- MCP setup can be part of project initialization.
- Acceptance criteria and task specs create useful human review checkpoints.
- File locking is worth adding early for local multi-process use.

What to avoid or defer:

- Do not build the full Kanban/browser surface before the CLI and brief are
  useful.
- Avoid letting UI shape the canonical data model too early.

Code-saving potential: high. This is the best implementation-shape reference
for a TypeScript Waystation.

### Markplane

Source: <https://github.com/zerowand01/markplane>

What it is:

- AI-native, markdown-first project management.
- Stores project state in repo files.
- Built-in MCP server.
- Generates compact `.context/` summaries so agents do not read everything.
- Rust CLI with a TypeScript web UI.

Useful lessons:

- Waystation's `brief` feature should be treated as core, not a later report.
- Generated compact context files are valuable:
  - `.waystation/context/summary.md`
  - `.waystation/context/active-work.md`
  - `.waystation/context/blocked.md`
  - `.waystation/context/index.md`
- Agents need an index/routing layer so they can load only relevant records.
- Token budgets should be explicit product behavior.

What to avoid or defer:

- Single-binary Rust packaging is attractive, but it is not the highest-leverage
  first step for Waystation.

Code-saving potential: high conceptually. Borrow the context-layer idea.

### Taskmaster

Source: <https://github.com/eyaltoledano/claude-task-master>

What it is:

- Task management system for AI-driven development.
- Node/TypeScript.
- MCP server binaries.
- Rich provider integrations and PRD/task decomposition features.

Useful lessons:

- MCP should expose the same core behavior as the CLI.
- Dependency-aware tasks and next-task selection matter.
- CLI packaging around `task-master` and `task-master-mcp` shows a practical
  distribution pattern.

What to avoid or defer:

- Do not add AI-provider integrations in Waystation V1.
- The license includes Commons Clause, so use it only as inspiration unless a
  specific dependency or file is license-compatible.

Code-saving potential: medium. Useful for MCP and CLI packaging patterns.

### Vibe Kanban

Source: <https://github.com/BloopAI/vibe-kanban>

What it is:

- Local workspace UI for running coding agents in isolated git worktrees.
- Rust backend with TypeScript frontend.
- Supports multiple coding agents, diff review, previews, PR creation, and
  workspaces.

Useful lessons:

- Git worktrees are the right isolation primitive for parallel agent work.
- Workspace/task/branch mapping is a valuable abstraction.
- Diff review and PR flow are useful later layers.

What to avoid or defer:

- This is much larger than Waystation V1.
- Waystation should first become the ledger; orchestration and review UI can
  come later.

Code-saving potential: medium. Good architecture reference for later
worktree/workspace features.

### Microsoft Conductor

Source: <https://github.com/microsoft/conductor>

What it is:

- Deterministic multi-agent workflow runner.
- Workflows are defined in YAML.
- Python 3.12+.
- Uses deterministic routing rather than LLM-based orchestration decisions.

Useful lessons:

- Deterministic YAML workflows are a good future extension.
- Human gates, explicit terminal states, and event logs are useful concepts.
- Routing logic should be visible and version-controlled.

What to avoid or defer:

- Waystation should not become an agent runner in V1.
- Workflow orchestration is adjacent, not the core ledger.

Code-saving potential: low for V1, useful later.

### Code Conductor

Source: <https://github.com/ryanmac/code-conductor>

What it is:

- GitHub Issues plus Claude Code plus isolated worktrees.
- Python and shell.
- Automates issue claiming, worktree creation, PR creation, and agent loops.

Useful lessons:

- GitHub Issues integration can be valuable, but should not be required.
- Worktree-per-agent is a simple and effective convention.
- Install/onboarding scripts can dramatically reduce setup friction.

What to avoid or defer:

- Waystation should stay tool-agnostic and local-first.
- Do not require GitHub, GitHub CLI, or Claude Code in V1.

Code-saving potential: low to medium. Borrow workflow ideas.

### conductor-ai

Source: <https://github.com/devinrosen/conductor-ai>

What it is:

- Local-first orchestration across repos, worktrees, tickets, and AI agent runs.
- Rust plus React.
- Backed by SQLite.
- Has CLI, TUI, web UI, and desktop directions.

Useful lessons:

- SQLite is a good local coordination database.
- A TUI can be useful for power users, but it is not necessary for V1.
- Ticket/worktree/agent-run sync is useful once the ledger core is mature.

What to avoid or defer:

- Too many interfaces too early can slow the core product.
- Waystation V1 should prioritize CLI, JSON, validation, and brief generation.

Code-saving potential: medium as an architecture reference, low for immediate
implementation.

## Borrowed Product Principles

- CLI first.
- JSON output on read commands.
- Plain files as source of truth.
- Rebuildable local index.
- Task dependencies are first-class.
- `ready` or `next` work discovery is core.
- Generated compact context is core.
- MCP should be a thin layer over the same core logic as CLI.
- Local dashboard can come after the CLI model settles.
- Worktrees are a later feature, not required for the first useful version.
- Avoid becoming a full project manager.
- Avoid becoming an autonomous agent runner in V1.

## Proposed V1 Scope

Build the smallest useful Waystation:

1. `waystation init`
2. Load and validate task records.
3. `waystation task list`
4. `waystation task show <id>`
5. `waystation task next`
6. `waystation task claim <id>`
7. `waystation task release <id>`
8. `waystation task finish <id>`
9. Append events to `.waystation/events.jsonl`.
10. `waystation brief --task <id>`
11. `waystation validate`
12. `waystation reindex`
13. Generate `.waystation/reports/STATUS.md`.
14. Generate compact `.waystation/context/*.md` files.

Defer until after V1:

- Dashboard.
- Full prompt rendering.
- GitHub Issues sync.
- Worktree creation.
- PR creation.
- Agent launching.
- Workflow orchestration.
- TUI.

## Decision

**Confirmed 2026-07-06: Bun + TypeScript, JSON canonical records.** The project
owner explicitly chose Bun. Canonical state is JSON; SQLite is the disposable
index; Markdown is generated one-way for humans. This gives the fastest path to
a useful CLI and dashboard while keeping the project easy for coding agents to
modify — which matters because Waystation is itself a tool for agent-assisted
development. Deno and Go were serious contenders and rejected (distribution,
Deno's main edge, is only a secondary priority; Bun won on DX, ecosystem, and
first-party `bun:sqlite`).

Recorded in `.waystation/decisions/decision-implementation-stack.json` and
`decision-record-format.json`; see `adr/ADR-0001` (accepted) and `adr/ADR-0002`
(superseded).
