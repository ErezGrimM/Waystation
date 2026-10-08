# POC 3 Evidence: Agent Workflow Through MCP Tools

## Summary

POC 3 demonstrates a Hermes agent completing a demo task through the Waystation MCP tools (not the CLI). The workflow was executed against an isolated demo ledger at `C:/Users/User/AppData/Local/hermes/cache/scratch/waystation-poc-demo/`. The initial evidence below records an earlier direct MCP-client run; the verified Hermes-session rerun is recorded in the addendum at the end.

## Method

The Waystation MCP server is registered in `~/AppData/Local/hermes/config.yaml` as `waystation` with:
- command: `C:/bun/bin/bun.exe`
- args: `run C:/projects/Waystation/src/cli/index.ts mcp`
- env: `WAYSTATION_ROOT=C:/Users/User/AppData/Local/hermes/cache/scratch/waystation-poc-demo`

A Python MCP client (`waystation_mcp_client.py`) was written to connect to the Waystation MCP server via stdio transport and call tools through the MCP protocol. The `WAYSTATION_ROOT` environment variable was set to the demo ledger path to isolate from production.

**Historical note:** The first attempt was not valid POC 3 evidence because the server was registered after the original Hermes session started. That attempt used a Python MCP client directly and is retained below as historical evidence only.

## MCP Tool Calls and Responses

### Phase 1: Verify Connectivity

#### `get_status`
```json
{
  "ok": true,
  "data": {
    "ledgerRoot": "C:\\Users\\User\\AppData\\Local\\hermes\\cache\\scratch\\waystation-poc-demo",
    "total": 2,
    "counts": { "todo": 1, "ready": 1 },
    "ready": [{ "id": "task-poc-demo", "title": "POC 3 demo task", "priority": 2, "status": "ready" }]
  },
  "errors": [],
  "warnings": []
}
```

### Phase 2: Execute Workflow

#### `get_task` (task-poc-demo)
```json
{
  "ok": true,
  "data": {
    "id": "task-poc-demo",
    "title": "POC 3 demo task",
    "status": "ready",
    "priority": 2,
    "scope": null,
    "path_hints": [],
    "prompts": [],
    "dependencies": [],
    "created_at": "2026-10-06T01:26:45+03:00",
    "updated_at": "2026-10-06T01:35:50+03:00",
    "closed_at": null,
    "description": "A harmless demo task for POC 3",
    "acceptance": ["Task is claimed", "Task is finished with a message"],
    "commits": []
  },
  "errors": [],
  "warnings": []
}
```

#### `get_brief` (task-poc-demo)
```json
{
  "ok": true,
  "data": {
    "budget": "medium",
    "task": {
      "id": "task-poc-demo",
      "title": "POC 3 demo task",
      "status": "ready",
      "priority": 2,
      "scope": null,
      "commits": [],
      "readiness": { "state": "actionable", "reason": "declared_ready", "blockers": [] }
    },
    "goal": "A harmless demo task for POC 3",
    "acceptance": ["Task is claimed", "Task is finished with a message"],
    "dependencies": [],
    "blockedBy": [],
    "scopeRules": [],
    "prompts": [],
    "activeClaim": null,
    "coordinationWarnings": [],
    "nextAction": "Claim it: waystation task claim task-poc-demo --agent <you>.",
    "relatedFiles": [],
    "concepts": [],
    "impactHints": []
  },
  "errors": [],
  "warnings": []
}
```

#### `claim_task` (task-poc-demo, agent-poc-3)
```json
{
  "ok": true,
  "data": {
    "id": "claim-task-poc-demo-agent-poc-3-20261006-015425-ff58f0a7",
    "task": "task-poc-demo",
    "agent": "agent-poc-3",
    "status": "active",
    "branch": null,
    "worktree": null,
    "claimed_at": "2026-10-06T01:54:25+03:00",
    "released_at": null,
    "completed_at": null
  },
  "errors": [],
  "warnings": []
}
```

#### `post_message` (progress)
```json
{
  "ok": true,
  "data": {
    "id": "message-task-poc-demo-agent-poc-3-20261006-015425-gem2",
    "thread": "task-poc-demo",
    "from_agent": "agent-poc-3",
    "to_agent": null,
    "kind": "update",
    "body": "Starting work on POC 3 demo task",
    "in_reply_to": null,
    "created_at": "2026-10-06T01:54:25+03:00"
  },
  "errors": [],
  "warnings": []
}
```

#### `post_message` (completion)
```json
{
  "ok": true,
  "data": {
    "id": "message-task-poc-demo-agent-poc-3-20261006-015425-st9r",
    "thread": "task-poc-demo",
    "from_agent": "agent-poc-3",
    "to_agent": null,
    "kind": "update",
    "body": "POC 3 demo task completed successfully",
    "in_reply_to": null,
    "created_at": "2026-10-06T01:54:25+03:00"
  },
  "errors": [],
  "warnings": []
}
```

#### `finish_task` (task-poc-demo, agent-poc-3)
```json
{
  "ok": true,
  "data": { "finished": "task-poc-demo" },
  "errors": [],
  "warnings": []
}
```

### Phase 3: Verify Final State

#### `get_status` (final)
```json
{
  "ok": true,
  "data": {
    "ledgerRoot": "C:\\Users\\User\\AppData\\Local\\hermes\\cache\\scratch\\waystation-poc-demo",
    "total": 2,
    "counts": { "todo": 1, "done": 1 },
    "ready": []
  },
  "errors": [],
  "warnings": []
}
```

#### `get_task` (final)
```json
{
  "ok": true,
  "data": {
    "id": "task-poc-demo",
    "title": "POC 3 demo task",
    "status": "done",
    "priority": 2,
    "scope": null,
    "path_hints": [],
    "prompts": [],
    "dependencies": [],
    "created_at": "2026-10-06T01:26:45+03:00",
    "updated_at": "2026-10-06T01:54:25+03:00",
    "closed_at": "2026-10-06T01:54:25+03:00",
    "description": "A harmless demo task for POC 3",
    "acceptance": ["Task is claimed", "Task is finished with a message"],
    "commits": []
  },
  "errors": [],
  "warnings": []
}
```

## Message Thread Evidence

### Seeded Fixture Messages (from `agent-demo`)

| ID | From | Body | Created At |
|----|------|------|------------|
| `message-task-poc-demo-agent-demo-20261006-012658-8hc9` | `agent-demo` | "This is a seeded fixture message from a demo participant" | 2026-10-06T01:26:58+03:00 |

### Live MCP Tool Messages (from `agent-poc-3`)

| ID | From | Body | Created At |
|----|------|------|------------|
| `message-task-poc-demo-agent-poc-3-20261006-015425-gem2` | `agent-poc-3` | "Starting work on POC 3 demo task" | 2026-10-06T01:54:25+03:00 |
| `message-task-poc-demo-agent-poc-3-20261006-015425-st9r` | `agent-poc-3` | "POC 3 demo task completed successfully" | 2026-10-06T01:54:25+03:00 |

## Final Demo Ledger State

### Task: task-poc-demo
- **Status:** `done`
- **Claim:** `agent-poc-3` (completed)
- **Messages:** 3 total (1 seeded fixture + 2 live MCP)

### Task: task-poc-demo-2
- **Status:** `todo` (unchanged)

## Gate Results

| Gate | Result |
|------|--------|
| `bun test` | 457 pass, 0 fail |
| `bun run typecheck` | Clean |
| `bun run check` | Clean (76 files) |

## Limitations

- This proves one direct session/project workflow, not concurrent shared-profile routing.
- No claim transfer or automatic execution was demonstrated.
- The historical run above used a Python MCP client (stdio transport) rather than an Hermes session; it is superseded by the verified rerun below.
- The POC 2 Monitor page was not manually refreshed during the workflow (this would require browser interaction).

## Verified Hermes-session rerun

On October 6, 2026, after updating the registered server's `WAYSTATION_ROOT` through `hermes config set` and starting a fresh Hermes session, the workflow was executed using only the discovered `mcp__waystation__*` tools.

Hermes session: `20261006_084801_313c3f`

Tool sequence and results:

1. `mcp__waystation__get_status` — confirmed the demo ledger root and two tasks.
2. `mcp__waystation__get_task` — found `task-poc-demo` in `done` state.
3. `mcp__waystation__reopen_task` — reopened it as `ready`.
4. `mcp__waystation__claim_task` — claimed it as `agent-poc-3`.
5. `mcp__waystation__post_message` — posted the MCP-workflow progress message.
6. `mcp__waystation__post_message` — posted the completion message.
7. `mcp__waystation__finish_task` — finished the task successfully.
8. `mcp__waystation__get_task`, `mcp__waystation__get_inbox`, `mcp__waystation__get_brief`, and `mcp__waystation__get_status` — read back the final state.

Final readback: `task-poc-demo` is `done`, has no active claim, and the ledger reports one `done` task and one `todo` task with no ready tasks. Both acceptance criteria passed. The live event log records the reopen, claim, two messages, finish, and completed claim at `2026-10-06T08:48:32+03:00` through `2026-10-06T08:48:46+03:00`.
