# AgentLedger Specification

## 1. Purpose

AgentLedger is a local-first coordination layer for human-AI coding workflows.
It helps humans and coding agents coordinate work across tasks, issues, prompts,
claims, handoffs, branches, worktrees, test runs, reviews, and progress events.

AgentLedger is designed for workflows where several coding agents may be used
in parallel or sequentially, such as Codex, Claude Code, OpenCode, Cursor, and
human developers. Its main job is to give each participant a shared, durable
source of truth while keeping the context each agent reads small and relevant.

AgentLedger is not a full project management system. It is an operational
ledger that lives beside or inside a code project.

One-sentence pitch:

> AgentLedger is a local-first task, issue, prompt, and handoff ledger that lets
> humans and AI coding agents coordinate safely across a codebase while reading
> only the context they need.

## 2. Core Problem

Multi-agent coding workflows are fragile because state is spread across chats,
git branches, generated notes, issue files, dashboards, and human memory.

Agents need fast answers to questions such as:

- What work is ready?
- What task am I supposed to work on?
- What context is relevant to this folder or file?
- Which prompts and rules apply?
- Who has claimed related work?
- What changed since the task was claimed?
- What issues or blockers are open?
- What did the previous agent leave behind?
- Which tests were run?
- Which task produced this commit?
- Can another agent safely start work here?

Without a ledger, every agent wastes context reconstructing project state.

## 3. Non-Goals

AgentLedger should not initially try to be:

- Jira, Linear, GitHub Issues, or a full project manager.
- A hosted SaaS product.
- A replacement for git.
- A replacement for CI.
- A replacement for codebase graph tools such as Graphify.
- An autonomous agent runner.
- A large web application.
- A general LLM prompting framework.
- A mandatory server dependency for CLI use.

## 4. Design Principles

### Local-First

Project state should live in or beside the project. A user should be able to
inspect, commit, copy, and back up the ledger without a hosted service.

### Tool-Agnostic

AgentLedger should work with any coding agent that can run CLI commands, read
text, or call MCP tools.

### Source Of Truth Is Inspectable

Canonical state should be stored in structured local files. Generated reports
and indexes can be rebuilt.

### Fast Scoped Retrieval

Agents should not read the whole ledger. Agents should ask for a task-scoped or
path-scoped brief and receive only the relevant context.

### Agent-Readable And Human-Readable

Records should be structured enough for tools and readable enough for humans.
Generated Markdown views may be produced for comfortable browsing.

### Append-Only History

Important state transitions should be recorded in an append-only event stream.
This provides auditability and lets the index be rebuilt.

### Rebuildable Index

A local query index may be used for speed, but it should be disposable. If the
index is deleted or stale, it can be rebuilt from canonical files and events.

### Clear Prompt Selection

Prompts are first-class records. Prompt selection should be scoped by agent,
role, task, folder, and project rules instead of dumping every prompt into every
agent session.

## 5. Project Directory Layout

Proposed default layout:

```text
.agentledger/
  config.json
  index.sqlite

  tasks/
    <task-id>.json

  issues/
    <issue-id>.json

  prompts/
    <prompt-id>.json

  scopes/
    <scope-id>.json

  claims/
    <claim-id>.json

  handoffs/
    <handoff-id>.json

  decisions/
    <decision-id>.json

  test-runs/
    <test-run-id>.json

  events.jsonl

  reports/
    STATUS.md

  views/
    tasks/
      <task-id>.md
    issues/
      <issue-id>.md
    prompts/
      <prompt-id>.md
```

Record format decision: canonical state is **JSON** (`config.json`, per-record
`*.json`, and append-only `events.jsonl`). See §6. Markdown under `views/` is
generated one-way from JSON and is not canonical (see §16).

Canonical files:

- `config.json`
- `tasks/*.json`
- `issues/*.json`
- `prompts/*.json`
- `scopes/*.json`
- `claims/*.json`
- `handoffs/*.json`
- `decisions/*.json`
- `test-runs/*.json`
- `events.jsonl`

Generated or rebuildable files:

- `index.sqlite`
- `reports/STATUS.md`
- `views/**/*.md`

## 6. Canonical Record Formats

The exact schema may evolve before implementation, but V1 records should stay
small, explicit, and easy to validate.

### 6.0 Canonical Write Policy

Canonical JSON and JSONL files are inspectable and may be edited manually for
recovery and bootstrapping. Normal mutations should go through the AgentLedger
core write path via CLI, MCP, or dashboard. Because canonical records are JSON
rather than a hand-tuned format, the primary human read surface is the
generated Markdown views (§16), and the primary human write surface is the CLI
and dashboard.

Agents should not directly edit canonical JSON files during normal operation.
Agents should send structured inputs to AgentLedger commands or MCP tools, and
AgentLedger should validate records, acquire the write lock, write canonical
files, append events, and update or invalidate the SQLite index.

Manual file edits remain supported as an escape hatch. `agentledger validate`
must detect malformed records and cross-reference errors after manual edits.

### 6.1 Project Config

```json
{
  "version": 1,
  "project_id": "duckbrain",
  "project_name": "DuckBrain",
  "root": ".",
  "defaults": {
    "agent": "unknown",
    "brief_budget": "medium",
    "status_report": ".agentledger/reports/STATUS.md"
  },
  "id_rules": {
    "task_prefix": "task",
    "issue_prefix": "issue",
    "prompt_prefix": "prompt",
    "scope_prefix": "scope"
  },
  "git": {
    "track_branches": true,
    "track_worktrees": true
  },
  "generated_views": {
    "enabled": true
  }
}
```

### 6.2 Task

Tasks are the central work records.

```json
{
  "id": "task-auth-login",
  "title": "Add login endpoint",
  "status": "ready",
  "priority": 2,
  "scope": "scope-auth",
  "path_hints": ["src/auth/"],
  "prompts": ["prompt-auth-conventions"],
  "dependencies": ["task-auth-model"],
  "created_at": "2026-07-05T10:00:00Z",
  "updated_at": "2026-07-05T10:00:00Z",
  "closed_at": null,
  "description": "Add the login endpoint for the auth module.\n",
  "acceptance": [
    "Login accepts valid credentials.",
    "Invalid credentials return a safe error.",
    "Passwords are never logged.",
    "Focused auth tests pass."
  ],
  "notes": "Follow existing handler patterns.\n"
}
```

Task status values:

```text
todo
ready
in_progress
blocked
review
done
wont_do
```

`claimed` should not be a task status. Claim state is tracked separately.

### 6.3 Issue

Issues track bugs, blockers, ambiguities, quality problems, and review findings.

```json
{
  "id": "issue-auth-redirect-loop",
  "title": "OAuth redirect loop after callback",
  "status": "open",
  "severity": "high",
  "priority": 1,
  "type": "bug",
  "task": "task-auth-login",
  "scope": "scope-auth",
  "file_hints": ["src/auth/callback.ts"],
  "opened_by": "codex",
  "assigned_to": null,
  "created_at": "2026-07-05T10:30:00Z",
  "updated_at": "2026-07-05T10:30:00Z",
  "closed_at": null,
  "description": "After a successful OAuth callback, the user is redirected back to /login.\n",
  "expected": "The user lands on the dashboard.\n",
  "actual": "The user returns to /login.\n",
  "evidence": [
    { "command": "bun test -- auth.redirect.spec.ts", "result": "failed" }
  ],
  "next_steps": [
    "Inspect callback URL normalization.",
    "Check provider redirect URI config."
  ]
}
```

Issue status values:

```text
open
triaged
in_progress
blocked
fixed
verified
closed
duplicate
wont_fix
```

Issue severity values:

```text
low
medium
high
critical
```

### 6.4 Prompt

Prompts are reusable instruction records. They may apply globally, to a scope,
to an agent, to a role, or to a specific task.

```json
{
  "id": "prompt-auth-conventions",
  "title": "Auth conventions",
  "version": 1,
  "status": "active",
  "applies_to": {
    "agents": ["codex", "claude-code", "opencode"],
    "roles": ["implementer", "reviewer"],
    "scopes": ["scope-auth"],
    "tasks": []
  },
  "priority": 50,
  "purpose": "Provide implementation and review rules for auth code.\n",
  "instructions": "Use bcrypt for password hashing. Never log passwords or tokens.\nFollow the patterns documented in src/auth/README.md.\n",
  "must_do": [
    "Check existing auth tests before editing handlers.",
    "Record actionable findings as AgentLedger issues."
  ],
  "must_not": [
    "Commit .env files.",
    "Print secrets in logs."
  ],
  "commands": {
    "start": ["agentledger brief --task {{task_id}} --agent {{agent}}"],
    "finish": ["agentledger handoff create --task {{task_id}}"]
  }
}
```

Prompt status values:

```text
draft
active
deprecated
archived
```

### 6.5 Scope

Scopes define path-aware context, ownership, defaults, and folder-specific
rules.

```json
{
  "id": "scope-auth",
  "name": "Auth module",
  "paths": ["src/auth/", "tests/auth/"],
  "owner": null,
  "default_prompts": ["prompt-auth-conventions"],
  "rules": [
    "Use bcrypt for password hashing.",
    "Never commit .env files.",
    "Never log passwords or tokens."
  ],
  "default_tests": ["bun test auth"],
  "notes": "Auth handlers should follow the existing controller/service split.\n"
}
```

### 6.6 Claim

Claims track who is working on what. A task may be blocked or in review while a
claim is still active.

```json
{
  "id": "claim-task-auth-login-codex-20260705-1005",
  "task": "task-auth-login",
  "agent": "codex",
  "status": "active",
  "branch": "codex/task-auth-login",
  "worktree": null,
  "claimed_at": "2026-07-05T10:05:00Z",
  "released_at": null,
  "completed_at": null,
  "notes": "Working on the login endpoint and focused auth tests.\n"
}
```

Claim status values:

```text
active
released
completed
stale
```

### 6.7 Handoff

Handoffs are explicit transfer records between agents or from an agent to the
next available worker.

```json
{
  "id": "handoff-task-auth-login-codex-20260705-1020",
  "task": "task-auth-login",
  "from_agent": "codex",
  "to_agent": null,
  "branch": "codex/task-auth-login",
  "worktree": null,
  "created_at": "2026-07-05T10:20:00Z",
  "summary": "Login endpoint is implemented. Password reset was not started.\n",
  "changed_files": ["src/auth/login.ts", "tests/auth/login.test.ts"],
  "tests": [
    { "command": "bun test auth", "status": "passed" }
  ],
  "unfinished": [
    "Add password reset endpoint.",
    "Add rate-limit test for login."
  ],
  "risks": ["Redirect URL handling was not reviewed."],
  "next_steps": [
    "Inspect src/auth/callback.ts.",
    "Run the full auth test suite."
  ]
}
```

### 6.8 Decision

Decisions record explicit choices that future agents should not rediscover.

```json
{
  "id": "decision-auth-password-hashing",
  "title": "Use bcrypt for password hashing",
  "status": "accepted",
  "scope": "scope-auth",
  "task": null,
  "created_at": "2026-07-05T10:15:00Z",
  "decided_by": "human",
  "context": "Auth module needs password hashing for local login.\n",
  "decision": "Use bcrypt. Do not introduce Argon2 in V1.\n",
  "consequences": [
    "Existing bcrypt dependency is reused.",
    "Password tests should use bcrypt-compatible fixtures."
  ]
}
```

Decision status values:

```text
proposed
accepted
superseded
rejected
```

### 6.9 Test Run

Test runs record commands and results relevant to tasks or scopes.

```json
{
  "id": "test-task-auth-login-20260705-1030",
  "task": "task-auth-login",
  "scope": "scope-auth",
  "agent": "codex",
  "command": "bun test auth",
  "status": "passed",
  "exit_code": 0,
  "elapsed_ms": 3400,
  "run_at": "2026-07-05T10:30:00Z",
  "summary": "Focused auth tests passed.\n",
  "output_path": null
}
```

Test status values:

```text
passed
failed
skipped
unknown
```

### 6.10 Message

Messages give parallel agents a shared, async inbox without a sidecar service,
chat server, or external tool. They are append-only and immutable (a correction
is a new message), posted through the core write path, and stored alongside the
work — so the coordination trail is as durable, timestamped, forkable, and
inspectable as every other record. This is the ongoing back-and-forth that
handoffs (§6.7, a one-shot baton pass) do not provide.

```json
{
  "id": "message-task-auth-login-codex-20260705-1042",
  "thread": "task-auth-login",
  "from_agent": "codex",
  "to_agent": null,
  "kind": "update",
  "body": "Login endpoint done; starting focused auth tests.",
  "in_reply_to": null,
  "created_at": "2026-07-05T10:42:00+03:00"
}
```

- `thread` — where the message lives. Either a record id (a task or issue) for
  a scoped conversation, or the reserved value `project` for the folder-wide
  channel every agent in the project shares. Scopes retrieval and keeps it
  cheap.
- `to_agent` — a specific recipient, or `null` for "anyone on this thread"
  (broadcast).
- `kind` — a small enum to let pollers filter cheaply, e.g. `update`,
  `question`, `verdict`, `note`.
- `in_reply_to` — another message id, for threading; `null` for a root message.

Message `kind` values:

```text
update
question
verdict
note
```

Chat is scoped **per project folder**: one `.waystation/` ledger is one shared
message space. There is no cross-project inbox — coordination stays local to
the folder the work lives in, alongside everything else in the ledger.

The **inbox is a query, not a stored object**: "messages where `to_agent` is me,
or `to_agent` is null on the `project` channel or on a thread I hold a claim on,
created since my last cursor." The SQLite index (§9) serves it. Read-state is a
per-agent cursor (a `--since` timestamp or stored cursor), not a mutation of the
message.

Agent protocol: because Waystation is not an agent runner (§3), polling cannot
be enforced — it is a convention carried by prompts (§6.4, §11). The default
project prompt instructs agents to check their inbox at session start and
periodically, to post updates at meaningful checkpoints (progress, decisions,
blockers, questions), and to answer questions addressed to them. A prompt's
`commands` may therefore include `start`, `during`, and `finish` hooks that run
`inbox` and `message post` alongside `brief` and `handoff`.

## 7. Event Model

Events are stored in `.agentledger/events.jsonl`, one JSON object per line.

Example:

```json
{"type":"task.created","task":"task-auth-login","actor":"human","ts":"2026-07-05T10:00:00Z"}
{"type":"task.claimed","task":"task-auth-login","claim":"claim-task-auth-login-codex-20260705-1005","actor":"codex","ts":"2026-07-05T10:05:00Z"}
{"type":"handoff.created","task":"task-auth-login","handoff":"handoff-task-auth-login-codex-20260705-1020","from":"codex","to":null,"ts":"2026-07-05T10:20:00Z"}
{"type":"test_run.recorded","task":"task-auth-login","test_run":"test-task-auth-login-20260705-1030","status":"passed","ts":"2026-07-05T10:30:00Z"}
```

Events should be logged for significant transitions and agent actions:

- `task.created`
- `task.updated`
- `task.status_changed`
- `task.claimed`
- `claim.released`
- `claim.completed`
- `issue.created`
- `issue.updated`
- `issue.closed`
- `decision.created`
- `handoff.created`
- `test_run.recorded`
- `prompt.rendered`
- `brief.generated`
- `message.posted`
- `index.rebuilt`
- `validation.failed`

Events should not be logged for every read-only command, dashboard page view, or
minor UI interaction.

## 8. ID Rules

Use human-readable prefixed slugs.

Examples:

```text
task-auth-login
issue-auth-redirect-loop
prompt-auth-conventions
scope-auth
claim-task-auth-login-codex-20260705-1005
handoff-task-auth-login-codex-20260705-1020
decision-auth-password-hashing
test-task-auth-login-20260705-1030
```

Reasons:

- Humans can recognize records.
- Agents can refer to records reliably.
- Git diffs are readable.
- There is less merge friction than counters.
- They are less opaque than UUIDs.

Validation must catch duplicate IDs.

## 9. Index Behavior

AgentLedger may maintain a local SQLite index for fast queries. The index is
not canonical.

Index responsibilities:

- Read canonical JSON records.
- Read append-only JSONL events.
- Provide fast task, issue, prompt, claim, handoff, and scope queries.
- Support path-aware lookups.
- Support text search if available.
- Support dashboard filtering.
- Support brief generation.

Index rules:

- The index can be deleted and rebuilt.
- Canonical writes should update or invalidate the index.
- `agentledger reindex` rebuilds the index from scratch.
- `agentledger validate` should detect stale or inconsistent index state.

## 10. Brief And Context Selection

The brief is the core feature.

Agents should not read all ledger files. Agents should call a command or MCP
tool that returns a small, task-scoped or path-scoped context package.

Example commands:

```bash
agentledger brief
agentledger brief --task task-auth-login
agentledger brief --scope scope-auth
agentledger brief --path src/auth/login.ts
agentledger brief --agent codex --budget medium
agentledger brief --task task-auth-login --json
```

Brief resolution order:

1. If `--task` is provided, use that task.
2. Else, if current branch or active claim maps to one task, use that task.
3. Else, if `--path` is provided, resolve matching scopes.
4. Else, resolve scope from current working directory.
5. If still ambiguous, return a short disambiguation list.

A brief should include:

- Task goal and acceptance criteria.
- Current task status.
- Active claim information.
- Relevant scope rules.
- Selected prompt summaries or rendered prompt content.
- Open issues for the task and scope.
- Recent handoffs for the task.
- Relevant decisions.
- Latest relevant test runs.
- Other active claims in the same scope.
- Recently touched files, when known.
- Potential conflicts.
- Next recommended action, when known.
- Optional Graphify-derived related files, concepts, call paths, and impact
  hints when a Graphify graph is configured and fresh enough.

A brief should exclude:

- Unrelated tasks.
- Closed issues unless explicitly requested.
- Full event history.
- Entire prompt library.
- Entire generated reports.
- Raw codebase graph output.

Graphify or other codebase-graph context should enrich briefs and rendered
prompts, not replace ledger state. Graph-derived context must be clearly
labeled as generated and staleable. If graph data is missing, stale, or
unavailable, brief generation should still succeed from canonical ledger
records alone.

Brief budget values:

```text
small
medium
large
full
```

Budgets should control output size, not correctness. The smallest brief should
still include the task goal, blockers, and next action.

## 11. Prompt Selection And Rendering

Prompts are selected by:

- Project defaults.
- Agent name.
- Agent role.
- Task references.
- Scope defaults.
- Path matches.
- Explicit CLI/MCP arguments.

Prompt precedence:

```text
global/project prompt
agent-specific prompt
role prompt
scope prompt
task prompt
live task brief
```

Example commands:

```bash
agentledger prompt list
agentledger prompt show prompt-auth-conventions
agentledger prompt render --task task-auth-login --agent codex --role implementer
agentledger prompt render --task task-auth-login --agent claude-code --json
agentledger prompt validate
```

Prompt rendering should support variables such as:

```text
{{task_id}}
{{agent}}
{{scope}}
{{branch}}
{{worktree}}
```

Prompt rendering should record `prompt.rendered` events when useful for audit.

Rendered prompts may include scoped codebase context from Graphify or a similar
codebase knowledge graph when configured. Prompt rendering should include only
the relevant slice for the task, scope, path, or file hints, such as related
files, concepts, call paths, dependency paths, and impact hints. It should not
dump the full graph or treat graph-derived facts as canonical project state.

## 12. Concurrency Rules

AgentLedger should allow different agents to work on different tasks at the
same time.

Rules:

- Two active claims for the same task should be rejected unless forced.
- Two agents may claim different tasks in the same scope.
- Briefs should warn about active claims in the same scope.
- Briefs should warn about overlapping file hints or changed files.
- Writes should be atomic.
- Event appends should be serialized enough to avoid corrupted JSONL.
- The dashboard should write through the same core write path as the CLI.

V1 does not need perfect distributed locking across machines. It should be
safe and predictable for local multi-process use.

## 13. CLI Command Spec

Every read command should support `--json` where practical.

### Core V1 Commands

```bash
agentledger init
agentledger status
agentledger status --json

agentledger task next
agentledger task next --scope scope-auth
agentledger task show task-auth-login
agentledger task claim task-auth-login --agent codex
agentledger task release task-auth-login --agent codex
agentledger task finish task-auth-login --agent codex

agentledger brief
agentledger brief --task task-auth-login --agent codex
agentledger brief --path src/auth/login.ts --agent claude-code
agentledger brief --json

agentledger prompt list
agentledger prompt show prompt-auth-conventions
agentledger prompt render --task task-auth-login --agent codex

agentledger handoff create --task task-auth-login --from codex --to claude-code
agentledger handoff show handoff-task-auth-login-codex-20260705-1020

agentledger validate
agentledger reindex
agentledger report
agentledger views render
```

### V1.5 Commands

```bash
agentledger issue add
agentledger issue list
agentledger issue show issue-auth-redirect-loop
agentledger issue close issue-auth-redirect-loop

agentledger decision add
agentledger decision list

agentledger test record --task task-auth-login -- bun test auth

agentledger message post --thread task-auth-login --from codex --body "Tests passing."
agentledger message post --thread task-auth-login --from codex --to reviewer --kind question --body "OK to merge?"
agentledger message post --thread project --from codex --kind note --body "Auth branch is green; starting billing."
agentledger message list --thread task-auth-login
agentledger message list --thread project
agentledger inbox --agent reviewer
agentledger inbox --agent reviewer --since 2026-07-05T10:00:00+03:00 --json

agentledger web
agentledger web --port 8787
agentledger web --open

agentledger mcp
```

## 14. MCP Tool Spec

MCP mode should expose typed tools over stdio. MCP is optional for users but
important for coding-agent ergonomics.

Possible V1 MCP tools:

```text
get_status
get_next_task
get_task
claim_task
release_task
get_brief
render_prompt
create_handoff
list_issues
create_issue
record_test_run
post_message
get_inbox
validate_ledger
```

MCP tools should call the same core logic as CLI commands. `post_message` and
`get_inbox` give a subagent a shared async inbox over stdio without any sidecar
service — the coder posts step updates and the audit agent polls verdicts
through the same ledger they already use.

## 15. Dashboard Spec

The dashboard is a local web UI over the same ledger. It is not a separate
source of truth.

Default:

```text
http://127.0.0.1:8787
```

Initial views:

- Overview
- Tasks
- Issues
- Prompts
- Scopes
- Claims
- Handoffs
- Decisions
- Test Runs
- Validation
- Generated Brief Preview

Dashboard capabilities:

- Add/edit tasks.
- Add/edit issues.
- Add/edit prompts.
- Add/edit scopes.
- View active claims.
- Create handoffs.
- Preview rendered prompts.
- Preview task/path/agent briefs.
- Run validation.
- Rebuild index.
- Generate reports and Markdown views.

Live updates:

- Dashboard writes should go through the core write path.
- The core write path should append events and emit in-process dashboard
  notifications.
- File watching may be used to detect external edits, but should not be the
  only source of dashboard live updates.

Security:

- Bind to `127.0.0.1` by default.
- Do not expose the dashboard on `0.0.0.0` unless explicitly requested.
- V1 does not require authentication for local-only use.

## 16. Generated Markdown And NotoView

AgentLedger may generate Markdown views for human browsing and for integration
with tools such as NotoView.

Generated examples:

```text
.agentledger/reports/STATUS.md
.agentledger/views/tasks/task-auth-login.md
.agentledger/views/issues/issue-auth-redirect-loop.md
.agentledger/views/prompts/prompt-auth-conventions.md
```

Rules:

- Generated Markdown is not canonical.
- Generation is strictly one-way: JSON records are rendered to Markdown.
  Markdown is never parsed back into records. Editing generated Markdown is
  neither required nor supported; edits go through the CLI or dashboard.
- Generated views can be deleted and recreated.
- Canonical JSON and JSONL remain the source of truth.

## 17. Git And Worktree Behavior

V1 should read git state but should not require advanced git automation.

Useful capabilities:

- Detect current branch.
- Detect worktree path.
- Map branch/worktree to active claim when possible.
- Record commits associated with a task.
- Warn when active claims share likely file paths.

Optional later:

- Create branches.
- Create worktrees.
- Open pull requests.
- Sync with GitHub Issues or PRs.

## 17.1 Graphify And Codebase Context

AgentLedger may optionally integrate with Graphify or similar codebase
knowledge-graph tools to enrich briefs and rendered prompts.

Graphify solves codebase understanding. AgentLedger solves work coordination.
The integration boundary should stay clear:

- AgentLedger remains canonical for tasks, issues, prompts, scopes, claims,
  handoffs, decisions, test runs, and events.
- AgentLedger tracks work coordination, not source-code inventory.
- Graphify output is generated context and may be stale.
- Graphify-derived context is best-effort and depends on Graphify's support
  for the project's languages and file types. Unsupported or niche languages
  may have weaker structural context, such as missing AST, import, call-graph,
  or symbol relationships.
- AgentLedger should consume Graphify output files and optional CLI query
  results; it should not reimplement or embed Graphify's analysis pipeline.
- Graphify's runtime and dependencies, including Python, Tree-sitter,
  NetworkX, and any configured LLM or vision backends, remain external to
  AgentLedger.
- Graphify data should be used to suggest related files, concepts, call paths,
  dependency paths, and impact hints.
- Graphify data should not decide task status, claim ownership, dependencies,
  or completion.

AgentLedger should not maintain a canonical ledger of all functions, classes,
imports, call edges, or symbols in the codebase. Those records change too
often, create noisy churn, and belong to Graphify or another codebase analysis
tool. AgentLedger may store lightweight references to code when they help
coordinate work:

```json
{
  "path_hints": ["src/auth/login.ts"],
  "symbol_hints": ["loginHandler", "verifyPassword"],
  "graph_refs": [
    "graphify:node:function:verifyPassword",
    "graphify:node:file:src/auth/login.ts"
  ]
}
```

These references are hints for brief generation and impact analysis. They are
not authoritative inventories of the codebase and should be validated against
current source or refreshed Graphify output when precision matters.

Expected Graphify outputs:

```text
graphify-out/
  graph.json
  GRAPH_REPORT.md
  graph.html
```

AgentLedger should primarily read `graph.json` and may read `GRAPH_REPORT.md`
for human-facing summaries. `graph.html` is an external visualization artifact
and does not need to be parsed by AgentLedger.

Possible configuration:

```json
{
  "integrations": {
    "graphify": {
      "enabled": true,
      "output_dir": "graphify-out",
      "graph_json": "graphify-out/graph.json",
      "report": "graphify-out/GRAPH_REPORT.md"
    }
  }
}
```

Possible commands:

```bash
agentledger graph status
agentledger graph import graphify-out/graph.json
agentledger related-files --task task-auth-login
agentledger impact --path src/auth/login.ts
agentledger brief --task task-auth-login --include graph
```

V1 does not require Graphify. If configured later, graph integration should be
optional, rebuildable, and safe to ignore when unavailable.

## 18. Validation Rules

`agentledger validate` should detect:

- Missing `.agentledger/config.json`.
- Invalid JSON records.
- Invalid JSONL event lines.
- Duplicate IDs.
- Invalid statuses.
- Missing required fields.
- Missing task dependency targets.
- Circular task dependencies.
- Missing prompt references.
- Missing scope references.
- Active claim for missing task.
- Multiple active claims for one task.
- Handoff for missing task.
- Issue for missing task or scope.
- Done task with active claim, unless forced.
- Done task without completion event.
- Optional: done task without recorded test run.
- Stale index.
- Generated report out of date.

Validation output should support text and JSON.

## 18.1 Error And Diagnostic Handling

Errors and warnings are structured, first-class output, not afterthoughts. The
CLI, MCP, and dashboard all render the same core diagnostics rather than
inventing their own formats (see §12, §20).

Every command returns a `CommandResult { ok, data, errors[], warnings[] }`, and
each entry is a `Diagnostic { code, message, details?, hint?, retryable }`:

- Codes are stable, `lower_snake_case`, and catalogued (they are a contract;
  breaking one requires a deprecation window). The `validate` codes in §18 are
  the first entries.
- Messages are fixed templates; dynamic values (ids, paths) go in `details`,
  never concatenated into the message. The underlying cause is kept in
  `details.cause` for logs while a stable code faces callers.
- `retryable` is set at the code/class level only — "could the same input ever
  succeed" — and is never a silently context-defaulted verdict.
- `errors` and `warnings` are arrays: whole-ledger checks (like `validate`)
  report every problem in one pass; warnings signal graceful degradation (e.g.
  a SQLite backend fallback) without flipping `ok` to false.
- CLI exit code is `0` when `ok` (warnings allowed) and `1` when `errors` is
  non-empty.

The threat model for V1 is hand-edited canonical files and concurrent local
processes, not injection: the layered defenses are zod-on-read, the single
locked atomic write path (§12), `validate` as the manual-edit guardrail (§18),
and append-only events plus a rebuildable index (§9). Blocklist/keyword
filtering is explicitly not used as a control.

Full rationale and examples: [docs/error-philosophy.md](docs/error-philosophy.md).

## 19. Storage And Git Policy

Recommended default:

Commit:

- `.agentledger/config.json`
- `.agentledger/tasks/*.json`
- `.agentledger/issues/*.json`
- `.agentledger/prompts/*.json`
- `.agentledger/scopes/*.json`
- `.agentledger/decisions/*.json`

Configurable:

- `.agentledger/claims/*.json`
- `.agentledger/handoffs/*.json`
- `.agentledger/test-runs/*.json`
- `.agentledger/messages/*.json`
- `.agentledger/events.jsonl`
- `.agentledger/reports/STATUS.md`
- `.agentledger/views/**/*.md`

Messages are one file per record (like claims and handoffs) rather than a
single append log: each agent writes its own new files, so parallel agents on
different branches never contend on the same file — the trail stays forkable
and merge-friendly. The inbox is reconstructed by the index, not by a shared
file.

Usually ignore:

- `.agentledger/index.sqlite`

Open question:

- Should claims be committed, local-only, or configurable per project?

## 20. Implementation-Agnostic Architecture

AgentLedger should have these logical layers regardless of programming stack:

```text
CLI / MCP / Dashboard
        |
Core ledger API
        |
Validation, prompt rendering, brief generation
        |
Canonical file storage + append-only events
        |
Rebuildable local query index
```

The CLI, MCP server, and dashboard must call the same core logic to avoid
behavior drift.

## 21. V1 Milestone

V1 should be intentionally small and useful:

1. Initialize `.agentledger/`.
2. Read/write JSON tasks, prompts, scopes, claims, and handoffs.
3. Append significant events to `events.jsonl`.
4. Build/rebuild SQLite index.
5. Validate records.
6. List and show tasks.
7. Find next ready task.
8. Claim and release tasks.
9. Generate task/path/agent-aware brief.
10. Render applicable prompts.
11. Create handoffs.
12. Generate `STATUS.md`.
13. Generate optional Markdown views.

No hosted server, no autonomous agent launching, and no required codebase graph
integration in V1.

## 22. Future Integrations

Possible future additions:

- MCP tool server.
- Local dashboard.
- Git branch/worktree creation.
- GitHub Issues import/export.
- GitHub PR and CI status import.
- Graphify import for related files and code context.
- Cross-project dashboard.
- Analytics reports.
- Agent performance summaries.
- Prompt effectiveness tracking.
- Hosted/team server mode.

## 23. Stack Decision Matrix

> **RESOLVED 2026-07-06 — stack is Bun + TypeScript.** See
> `.waystation/decisions/decision-implementation-stack.json`. The TypeScript
> subsection below is the chosen path (now specifically Bun, with `bun:sqlite`,
> commander, zod, Hono, Vite + React, Biome, and `bun:test`; MCP SDK deferred).
> Canonical records are JSON, so the YAML parsing libraries listed per stack no
> longer apply — see `decision-record-format.json`. The Rust and Go subsections
> are retained as historical rationale only.

This section is intentionally separate from the product spec. The model above
should work across multiple implementation stacks.

### Rust

Strengths:

- Single binary.
- Very fast startup.
- Strong type system.
- Excellent for validation-heavy tools.
- Good long-term reliability.

Tradeoffs:

- Slower product iteration.
- More boilerplate.
- Dashboard and MCP iteration may take longer.

Likely stack:

```text
clap
serde
serde_yaml
serde_json
rusqlite
axum
tokio
askama
notify
```

### Go

Strengths:

- Single binary.
- Simple CLI/server implementation.
- Good cross-platform story.
- Easier than Rust for many contributors and agents.

Tradeoffs:

- Less expressive type modeling than Rust.
- Dashboard ergonomics less rich than TypeScript.

Likely stack:

```text
cobra
yaml.v3
encoding/json
SQLite driver
net/http
html/template
embed
```

### TypeScript / Node

Strengths:

- Fastest iteration for CLI plus dashboard.
- Natural MCP SDK fit.
- Easy `npx` or `pnpm dlx` adoption.
- Familiar to many AI coding workflows.
- Strong web/dashboard ecosystem.

Tradeoffs:

- Requires Node or bundling.
- Single-binary distribution is less straightforward.
- More dependency management.

Likely stack:

```text
Node 22+
pnpm
commander or clipanion
yaml
SQLite via node:sqlite or better-sqlite3
Hono or Express
Vite plus small UI library, or server-rendered HTML
@modelcontextprotocol/sdk
```

### Stack-Neutral Recommendation

Choose the stack based on the first implementation goal:

- Fastest prototype and MCP/dashboard iteration: TypeScript.
- Most dependable standalone developer tool: Go.
- Most rigorous long-term CLI/indexing tool: Rust.

The ledger model, CLI behavior, brief rules, and record formats should be
locked before committing to any implementation stack.
