# Migration Guide

This guide explains how to migrate work from another task management system
into Waystation. It is written for both humans and LLM agents.

Waystation's canonical state is plain JSON under `.waystation/`. Migration is
therefore a data-mapping task, not an API integration requirement.

## Recommended Workflow

1. Export the source system to JSON or CSV.
2. Create a migration branch or worktree.
3. Ask an LLM or script to produce a mapping plan before writing records.
4. Generate Waystation JSON records into `.waystation/tasks/`, `.waystation/issues/`,
   and optionally `.waystation/messages/`, `.waystation/scopes/`, and
   `.waystation/prompts/`.
5. Run:

```ps1
.\waystation.exe reindex
.\waystation.exe validate
.\waystation.exe report --views
.\waystation.exe task next
```

6. Review a representative sample.
7. Commit only after validation is clean and the mapping feels right.

## LLM Migration Prompt

Use a prompt like this before generating files:

```text
You are migrating exported task-management data into Waystation.

First produce a mapping plan. Do not write records yet.

Source system:
- Name:
- Export files:
- Important fields:

Waystation constraints:
- Canonical records are JSON files under .waystation/.
- Tasks use .waystation/tasks/<id>.json and must match TaskRecord.
- Issues use .waystation/issues/<id>.json.
- Messages use .waystation/messages/<id>.json.
- Do not invent dependencies, scopes, or claims silently.
- Preserve source ids in notes/descriptions when useful.
- Use stable kebab-case ids.
- Prefer notes over lossy deletion when unsure.

Return:
1. Field mapping table.
2. Status mapping table.
3. Priority/severity mapping table.
4. Which source records become tasks vs issues.
5. Ambiguities requiring human decision.
6. A validation and sample-review plan.
```

After the mapping is approved, ask the LLM to generate records in small batches
and run validation after each batch.

## Core Record Mapping

### Tasks

Use tasks for planned work that an agent or human can claim and complete.

Minimum useful task:

```json
{
  "id": "task-example",
  "title": "Example task",
  "status": "todo",
  "priority": 3,
  "scope": "scope-core",
  "path_hints": ["src/core/"],
  "prompts": ["prompt-waystation-v1"],
  "dependencies": [],
  "created_at": "2026-07-16T06:25:43+03:00",
  "updated_at": "2026-07-16T06:25:43+03:00",
  "closed_at": null,
  "description": "What and why. Include source-system id if useful.",
  "acceptance": ["Specific, testable criterion."],
  "notes": "Migration notes, source links, ambiguity, or original metadata."
}
```

Task status mapping:

| Source meaning | Waystation status |
|---|---|
| Backlog, proposed, not started | `todo` |
| Ready for implementation | `ready` |
| Actively being worked | `in_progress` only if you also migrate an active claim; otherwise usually `ready` |
| Blocked | `blocked` |
| In review / QA | `review` |
| Completed / shipped | `done` |
| Canceled / rejected / duplicate | `wont_do` |

Priority mapping:

| Source meaning | Waystation priority |
|---|---|
| Urgent / blocker / P0 | `1` |
| High | `2` |
| Normal / medium | `3` |
| Low | `4` |
| Nice-to-have / someday | `5` |

Dependencies:

- Map explicit blockers/dependencies to `dependencies`.
- Do not infer dependencies from comments like "related to" unless the source
  clearly means "must be done first".
- If a dependency target is not migrated, either migrate it too or leave a note.
  `waystation validate` will flag missing dependencies.

Acceptance criteria:

- Convert checklists, subtasks, or Definition of Done into `acceptance`.
- Keep acceptance testable.
- If the source has no acceptance criteria, derive a conservative first pass
  from the title/body and mark it in `notes` as migrated/derived.

### Issues

Use issues for bugs, risks, review findings, or defects that may or may not
correspond to a task.

Common issue fields:

```json
{
  "id": "issue-example",
  "title": "Example issue",
  "status": "open",
  "severity": "medium",
  "type": "bug",
  "priority": 2,
  "scope": "scope-core",
  "task": "task-example",
  "description": "What is wrong and how to reproduce or evaluate it."
}
```

Issue mapping:

| Source concept | Waystation field |
|---|---|
| Bug/defect kind | `type: "bug"` |
| Risk/security/performance label | `type` or `severity` |
| Linked story/task | `task` |
| Component/team/package | `scope` |
| Closed/fixed state | `status: "fixed"` or `status: "closed"` |

Prefer tasks when the record is primarily planned work. Prefer issues when the
record is primarily a defect, review finding, or risk.

### Messages and Comments

Source comments can become Waystation messages when they contain useful context
for future agents.

Use messages for:

- decisions made in a thread
- blocker explanations
- handoff context
- important review comments
- coordination notes

Usually skip or summarize:

- "+1", "thanks", or reactions
- automated status churn
- bot notifications that are already represented by task status

Message fields:

```json
{
  "id": "message-task-example-migrator-20260716-062543-a1b2",
  "thread": "task-example",
  "from_agent": "migrator",
  "to_agent": null,
  "kind": "note",
  "body": "Migrated comment summary or original comment text.",
  "in_reply_to": null,
  "created_at": "2026-07-16T06:25:43+03:00"
}
```

If preserving every comment would create noise, summarize the thread in the
task `notes` field and migrate only high-signal comments.

### Claims and Assignees

Waystation claims represent active ownership, not historical assignment.

Recommended mapping:

| Source concept | Waystation mapping |
|---|---|
| Current assignee on active work | active claim only if work is truly in progress |
| Historical assignee | task `notes` |
| Reviewer | task `notes` or message |
| Team/component owner | scope record or task `scope` |

Avoid creating active claims during migration unless you are intentionally
resuming active work. A migrated active claim can make a task appear occupied.

### Scopes

Scopes group paths, rules, and default prompts.

Map source components, teams, repos, packages, or areas to scopes when they help
agents choose files and rules. Reuse existing scopes when possible:

- `scope-core`
- `scope-cli`
- `scope-dashboard`
- `scope-git`

Create new scopes only when there is a stable boundary with useful rules.

### Labels and Tags

Labels rarely map one-to-one. Recommended handling:

| Label type | Suggested destination |
|---|---|
| Component label | `scope` or `path_hints` |
| Priority label | `priority` |
| Severity label | issue `severity` |
| Type label | issue `type` |
| Status label | task/issue `status` |
| Misc label | `notes` |

Keep original labels in `notes` when the mapping is uncertain.

## Source-System Hints

### GitHub Issues

Waystation already has GitHub import/export support. Prefer that path when it
fits:

```ps1
$env:GITHUB_TOKEN = "<token>"
.\waystation.exe gh import --repo owner/name
.\waystation.exe validate
```

Then review labels/status mapping and decide whether some imported issues
should become tasks.

### Jira

Suggested mapping:

| Jira | Waystation |
|---|---|
| Epic | scope, notes, or parent task depending on use |
| Story/task | task |
| Bug | issue, or task if it is planned implementation work |
| Sub-task | acceptance criterion or dependency task |
| Blocked by / relates to | dependency only if blocking is explicit |
| Sprint | notes, not a first-class field |
| Component | scope/path hints |

Jira workflows are often custom. Always produce a status mapping table before
writing records.

### Linear

Suggested mapping:

| Linear | Waystation |
|---|---|
| Issue | task or issue depending on type |
| Project | scope or notes |
| Team | scope |
| Cycle | notes |
| Priority | priority |
| Labels | scope/type/severity/notes |

Linear comments often contain useful handoff context; migrate high-signal
comments as messages or summarize them in task notes.

### Trello / Kanban Boards

Suggested mapping:

| Trello | Waystation |
|---|---|
| Card | task |
| List | status mapping |
| Checklist item | acceptance criterion or separate task |
| Label | priority/scope/type/notes |
| Card comments | messages or notes |

Be careful with list names like "Doing" or "Review"; decide whether those map
to `in_progress` / `review` or simply to `ready` with notes.

## ID Strategy

Good ids are stable, readable, and filesystem-safe:

```text
task-auth-refresh-token-rotation
issue-dashboard-static-route-traversal
message-task-auth-refresh-token-rotation-migrator-20260716-062543-a1b2
```

Rules:

- Use lowercase kebab-case.
- Prefix with `task-`, `issue-`, or `message-`.
- Use only letters, digits, `.`, `_`, and `-`.
- Start every id with a letter or digit.
- Never include `/`, `\`, spaces, `..`, query strings, fragments, or URL text.
- The filename must exactly match the record id: `.waystation/tasks/task-x.json`
  must contain `"id": "task-x"`.
- Preserve the source id in `notes` or `description`, not necessarily in the
  Waystation id.
- Do not rename ids after agents start depending on them unless necessary.

The same safe-id rule applies to references such as `dependencies`, `scope`,
`prompts`, issue `task`, message `thread`, and message `in_reply_to`.
`thread: "project"` is the only reserved non-record thread value.

When a source id is not filesystem-safe, keep it as metadata instead:

```json
{
  "id": "task-jira-auth-123",
  "notes": "Source id: AUTH/123?selected=true"
}
```

Do not use source URLs as ids. Put URLs in `notes` or `description`.

## Batch Strategy

For small migrations, generate everything in one branch and validate.

For larger migrations:

1. Migrate scopes first.
2. Migrate active/open tasks.
3. Migrate closed tasks.
4. Migrate issues.
5. Migrate high-signal comments/messages.
6. Reindex and validate after each batch.

This makes errors easier to isolate.

## Validation and Review

Required commands:

```ps1
.\waystation.exe reindex
.\waystation.exe validate
.\waystation.exe report --views
.\waystation.exe task next
```

Recommended sample checks:

```ps1
.\waystation.exe task list --json
.\waystation.exe task show task-sample
.\waystation.exe brief --task task-sample --budget medium
.\waystation.exe message list --thread task-sample
```

Review checklist:

- Statuses match the source intent.
- Done/canceled records are not accidentally ready.
- Active claims exist only for work that is truly active.
- Record filenames match their body ids exactly.
- IDs and references are filesystem-safe.
- Dependencies all point to migrated task ids.
- Priorities are not all urgent.
- Scopes and path hints are useful to agents.
- Acceptance criteria are actionable.
- Source ids or URLs are preserved somewhere.
- No low-signal comment noise overwhelms briefs.
- `waystation validate` is clean.

## Common Failure Modes

### Everything Becomes A Task

Bug reports, audit findings, and risks often belong in `.waystation/issues/`.
Use tasks for planned work; use issues for defects or findings.

### Every Assignee Becomes An Active Claim

Do not migrate historical assignment into active claims. Claims are operational
coordination records.

### Dependencies Are Over-Inferred

"Related to" does not mean "depends on". Missing or incorrect dependencies make
the ready queue misleading.

### Comments Flood The Inbox

Migrate high-signal comments. Summarize noisy threads in `notes`.

### Labels Are Treated As Truth

Labels are often inconsistent. Preserve unmapped labels in `notes` and map only
the ones with clear operational meaning.

## When To Write An Importer

A one-off LLM-assisted migration is enough when:

- the export is small
- the mapping is custom
- you only need to migrate once

Write an importer when:

- the source system will be synced repeatedly
- the export has hundreds or thousands of records
- the mapping has stable rules
- you need repeatable dry-runs

If writing an importer, keep it outside the core write path until the mapping is
reviewed. Generate JSON records, then let `reindex` and `validate` judge the
result.
