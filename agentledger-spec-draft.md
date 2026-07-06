# Agent Work Ledger Spec Draft

## Working Name

`agentledger`

Other possible names:

- `agenttrack`
- `workledger`
- `taskgraph`
- `agentboard`

## Purpose

`agentledger` is a local-first project tracking CLI for human-AI coding
workflows. It gives coding agents and humans a shared source of truth for
tasks, claims, dependencies, branches, worktrees, blockers, commits, test runs,
and handoffs.

It is not a full project management app. It is the durable operational layer
between:

- issue/task files
- git branches and worktrees
- multiple coding agents
- subagents spawned by a parent agent
- generated status dashboards
- CI and PRs
- local project memory

## Core Problem

Current multi-agent coding workflows are fragile because state is spread across
chats, git branches, issue files, generated dashboards, and human memory.

Agents need answers to questions like:

```text
What work is ready?
What is claimed?
Who owns this branch?
Which subagents are working under this task?
What is blocked?
What changed since the task was claimed?
Which tests were run?
Which task produced this commit?
Can I safely start another task?
```

Today those answers are usually reconstructed manually.

## Non-Goals

`agentledger` should not try to be Jira, Linear, GitHub Issues, or a full web
project manager.

Initial non-goals:

- hosted SaaS
- real-time collaboration server
- replacing git
- replacing GitHub/GitLab issues
- autonomous agent execution
- large web UI
- LLM-specific prompting framework
- deep codebase analysis like Graphify

## Related Projects

These projects overlap with parts of the idea and should be studied before
building:

- [Beads](https://github.com/gastownhall/beads): distributed graph issue
  tracker for AI agents, exposed through the `bd` CLI. It supports dependencies,
  ready-work discovery, JSON output, agent integrations, and a project-local
  `.beads/` database. This is the closest ready-made match to the original
  `agentledger` concept and should be evaluated before building anything new.
- [git-issues](https://pkg.go.dev/github.com/steviee/git-issues): git-native
  issue tracker that stores issues as Markdown files with YAML frontmatter under
  `.issues/`.
- [taskmd](https://medium.com/%40driangle/taskmd-task-management-for-the-ai-era-92d8b476e24e):
  local-first Markdown task system aimed at AI coding agents, using structured
  frontmatter.
- [ai-trackdown](https://github.com/bobmatnyc/ai-trackdown): AI-native
  Markdown task and documentation framework for human-AI development.
- [Code Conductor](https://github.com/ryanmac/code-conductor): GitHub
  Issues-based multi-agent workflow that lets coding agents claim tasks and work
  in isolated git worktrees.
- [Mission Control](https://github.com/MeisnerDan/mission-control):
  open-source task management for delegating work to AI agents, with an
  app/daemon orientation.
- [Microsoft Conductor](https://github.com/microsoft/conductor):
  open-source CLI for deterministic multi-agent workflows defined in YAML; more
  orchestration-focused than issue-tracking-focused.
- [Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md): self-hosted
  Markdown-file Kanban board.
- [OpenProject](https://github.com/opf/openproject): full open-source project
  management suite; much heavier than the intended local-first agent ledger.
- [Graphify](https://github.com/safishamsi/graphify): codebase knowledge graph
  skill for AI coding assistants. It solves project understanding rather than
  operational work coordination, but its generated graph/report pattern is
  relevant.

## Design Principles

Local-first:
Project state lives in the repo or beside the repo.

Git-native:
Tasks and state should be reviewable, diffable, and branch-aware.

Agent-readable:
Files and generated reports must be easy for AI agents to parse.

Human-readable:
The primary dashboard should be useful without a special UI.

Queryable:
A DuckDB-backed index should allow rich queries without forcing users into a
hosted database.

Conservative source of truth:
Canonical state should be plain files. DuckDB is an index/cache unless the
project later decides otherwise.

Tool-agnostic:
Should work with Codex, Claude Code, OpenCode, Cursor agents, shell scripts,
and humans.

## Data Model

Canonical files may live under:

```text
.agentledger/
  config.yml
  tasks/
    LOW-01.yml
    SPD-05.yml
  claims/
    active.yml
  reports/
    STATUS.md
  ledger.duckdb
```

Initial entities:

```sql
tasks
- id
- title
- description
- status
- priority
- effort
- component
- assignee
- branch
- worktree
- created_at
- updated_at
- closed_at
- source_path

task_dependencies
- task_id
- depends_on_task_id
- relationship_type

claims
- id
- task_id
- agent
- branch
- worktree
- status
- claimed_at
- released_at
- notes

events
- id
- task_id
- event_type
- actor
- message
- created_at

commits
- hash
- task_id
- branch
- subject
- authored_at
- pushed
- pr_url

test_runs
- id
- task_id
- commit_hash
- command
- status
- elapsed_seconds
- summary
- run_at

subagent_runs
- id
- parent_task_id
- parent_claim_id
- subagent_name
- role
- goal
- status
- worktree
- branch
- started_at
- finished_at
- result_summary

blockers
- id
- task_id
- reason
- blocked_by
- created_at
- resolved_at
```

## Task Statuses

Suggested initial statuses:

```text
todo
ready
claimed
in_progress
blocked
review
done
wont_do
```

Consider keeping `claimed` separate from `status`, because a task can be
`blocked` and still claimed.

## Core CLI Commands

Minimum useful v1:

```bash
agentledger init
agentledger status
agentledger next
agentledger list
agentledger show TASK-ID
agentledger claim TASK-ID
agentledger release TASK-ID
agentledger block TASK-ID --reason "..."
agentledger unblock TASK-ID
agentledger finish TASK-ID
agentledger validate
agentledger doctor
agentledger sync
agentledger report
```

Useful git-aware commands:

```bash
agentledger worktree create TASK-ID
agentledger branch TASK-ID
agentledger commit TASK-ID
agentledger pr TASK-ID
```

Useful subagent commands:

```bash
agentledger subagent start TASK-ID --name reviewer --role review --goal "Review SQL loader changes"
agentledger subagent finish SUBAGENT-RUN-ID --summary "No blockers found"
agentledger subagent fail SUBAGENT-RUN-ID --summary "Tests fail in internal/csv"
agentledger subagent list TASK-ID
```

Useful query commands:

```bash
agentledger query "select * from ready_tasks"
agentledger export --format json
agentledger import
```

## Generated Artifacts

`agentledger report` should generate:

```text
.agentledger/reports/STATUS.md
```

Possible sections:

```markdown
# Project Status

## Ready To Claim
## Currently Claimed
## Blocked
## In Review
## Recently Finished
## Dependency Graph
## Agent Workloads
## Branch / Worktree Map
## Test Run Summary
```

This is the file agents should read first.

## DuckDB Role

DuckDB should be used as a local query/index layer.

Inputs:

- task YAML/Markdown
- claim state
- git commits
- worktree metadata
- test run logs
- PR metadata, if available

Outputs:

- query results
- validation failures
- generated reports
- dependency summaries
- next-task ranking

DuckDB should not be required to manually edit project state in v1. It can be
rebuilt from files.

## Graphify Relationship

Graphify and similar tools solve codebase understanding. `agentledger` solves
work coordination.

Possible integration:

```bash
agentledger graph import graphify-out/graph.json
agentledger impact TASK-ID
agentledger related-files TASK-ID
```

This should be optional and later.

## Example Task File

```yaml
id: LOW-02
title: Index streaming preview merge region lookups
status: done
priority: medium
effort: medium
component: excel
assignee: codex
branch: codex/low-02
depends: []
created_at: 2026-07-03T09:30:00Z
updated_at: 2026-07-03T11:05:00Z

description: |
  Reduce repeated linear scans over merge regions during streaming preview.

acceptance:
  - Streaming preview behavior is unchanged.
  - Merge lookup benchmark shows improvement.
  - Focused Excel tests pass.
  - Full test suite passes.
```

## Example Claim File

```yaml
active_claims:
  - task_id: SBI-01
    agent: claude
    branch: claude/sbi-01
    worktree: C:\Projects\DuckBrain\.claude\worktrees\sbi-01
    status: in_progress
    claimed_at: 2026-07-03T08:10:00Z
    notes: Working on json column metadata.
```

## Validation Rules

`agentledger validate` should catch:

- duplicate task IDs
- invalid statuses
- missing required fields
- missing dependency targets
- circular dependencies
- task claimed by multiple agents
- claimed task without branch/worktree
- branch does not exist
- worktree path does not exist
- done task without completion event
- done task without commit reference, configurable
- generated report out of date
- DuckDB index out of date

## Agent Workflow

Typical flow:

```bash
agentledger status
agentledger next
agentledger claim LOW-02
agentledger worktree create LOW-02
# agent works
agentledger test LOW-02 -- go test -count=1 ./...
agentledger finish LOW-02 --commit d51d5c62
agentledger report
```

## Subagent Workflow

Subagents should be tracked as child work under a parent task or claim. The
parent agent remains responsible for final integration, but the ledger records
who did each focused slice of work and what result came back.

Typical flow:

```bash
agentledger claim SPD-05
agentledger subagent start SPD-05 --name reviewer --role review --goal "Review byte-cap trimming logic"
agentledger subagent start SPD-05 --name tester --role test --goal "Run focused output tests"
# subagents work in their own context, branch, or worktree if needed
agentledger subagent finish reviewer --summary "Suggested exact-fit guard for skewed rows"
agentledger subagent finish tester --summary "Focused tests pass"
agentledger finish SPD-05 --commit ced20f70
```

Subagent support should answer:

- Which task spawned this subagent?
- What role or goal was it assigned?
- Did it touch files, create a branch, or use a worktree?
- Did it return findings, patches, test results, or blockers?
- Has the parent agent integrated or rejected the result?
- Are any subagents still running before the task can be finished?

Subagent state should roll up into task status. A task with running subagents
should not be marked done unless forced with an explicit override.

## Storage Strategy

Recommended v1:

Canonical:

```text
.agentledger/tasks/*.yml
.agentledger/claims/active.yml
.agentledger/events/*.jsonl
.agentledger/subagents/*.jsonl
```

Generated/cache:

```text
.agentledger/ledger.duckdb
.agentledger/reports/STATUS.md
```

Git policy:

- task files: committed
- reports: optionally committed
- DuckDB file: usually ignored
- event logs: maybe committed for auditability, configurable

## Implementation Language

For a standalone project, recommended v1: Go.

Reasons:

- simple static binaries
- good CLI ecosystem
- easy git/process integration
- DuckDB Go bindings exist
- straightforward distribution

Rust remains a good alternative if the project prioritizes type-level modeling
and long-term CLI polish over speed of implementation.

## Possible v1 Milestone

V1 should be intentionally small:

1. `init`
2. YAML task parsing
3. `list`, `show`, `next`
4. `claim`, `release`, `finish`
5. DuckDB index rebuild
6. `validate`
7. Markdown `STATUS.md` generation
8. Git branch/worktree detection
9. Basic subagent run tracking

No daemon. No web UI. No agent launching.

## Open Questions

- Should canonical tasks be YAML-only, Markdown with frontmatter, or either?
- Should active claims be committed or local-only?
- Should reports be committed?
- Should the DuckDB file be cache-only or allowed as source of truth later?
- Should GitHub Issues import/export be first-class?
- Should `agentledger` create worktrees itself or only track them?
- Should there be a formal task ID scheme?
- Should event history be append-only?

## One-Sentence Pitch

`agentledger` is a local-first, git-aware task ledger for coordinating multiple
coding agents across branches, worktrees, tests, commits, and handoffs.
