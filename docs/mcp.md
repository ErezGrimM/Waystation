# MCP stdio server

Waystation exposes the same core behavior to coding agents through a Model
Context Protocol (MCP) **stdio** server. The server is local-only: it binds one
ledger root for the lifetime of the process, speaks newline-delimited JSON-RPC
over standard input/output, and needs no daemon or hosted service.

## Launch modes

There are two equivalent ways to launch the server. Pick whichever matches how
you run the CLI.

### Source mode

Run the TypeScript entrypoint directly with Bun. Bun is installed at
`C:\bun\bin\bun.exe` on this machine and is **not** on `PATH`, so call it by
full path:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun run C:\Projects\Waystation\src\cli\index.ts mcp
```

Use this mode during development, or anywhere the checkout and Bun are present.
No rebuild is needed.

### Compiled mode

Run the compiled single-file executable. This needs no Bun installation at all,
so it is the preferred mode for clients and other local projects:

```ps1
C:\Projects\Waystation\waystation.exe mcp
```

Rebuild the binary after source changes:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun build --compile src/cli/index.ts --outfile waystation.exe
```

### Choosing between them

| | Source mode | Compiled mode |
|---|---|---|
| Command | `& $bun run <checkout>\src\cli\index.ts mcp` | `.\waystation.exe mcp` |
| Requires Bun | yes (`C:\bun\bin\bun.exe`) | no |
| Tracks source | yes (no rebuild) | only after `bun build --compile` |
| Best for | developing Waystation itself | MCP clients, other local projects |

## Working directory and ledger discovery

The server resolves the ledger root once at startup and binds all tools to it
for the whole session. Resolution follows this order:

1. `--root <path>` — explicit root wins over everything.
2. `WAYSTATION_ROOT=<path>` environment variable.
3. **Upward discovery** from the process working directory: the first ancestor
   directory containing a `.waystation/` ledger.

Consequences:

- **Run the server from inside the project** (any subdirectory) to bind that
  project's ledger: `C:\Projects\Waystation\src\core` resolves to
  `C:\Projects\Waystation`.
- **To target a different ledger** without changing directory, pass `--root` or
  set `WAYSTATION_ROOT`. For example, a client that runs the server with a fixed
  working directory can point at another project's ledger explicitly.
- **If no ledger is found**, the server fails at startup with `ledger_not_found`
  rather than silently binding an empty root.

Configure the client with the working directory set to the project root (or the
desired ledger's parent), or set `--root`/`WAYSTATION_ROOT` explicitly.

## Capabilities

All tools return the standard `CommandResult` envelope (`ok`, `data`, `errors`,
`warnings`) as JSON text.

**Read / inspect**

- `get_status` — task counts by status plus the ready list
- `get_next_task` — single highest-priority ready task, or `null`
- `get_task` / `get_issue` — fetch one record by id
- `get_brief` — task-scoped context brief (budget `small|medium|large|full`)
- `render_prompt` — applicable prompts for a task/agent context
- `list_issues` / `list_prompts` — list records
- `get_inbox` — messages addressed to an agent (with optional `since` cursor)
- `validate_ledger` — full structural/semantic validation
- `get_git_context` — git/worktree state, active claims, overlap warnings

**Write (single core write path)**

- `create_task` / `update_task` / `set_task_status` / `reopen_task`
- `claim_task` / `release_task` / `finish_task` / `add_task_commit`
- `create_handoff`
- `post_message`
- `create_issue` / `update_issue` / `close_issue`

## Client configuration

A local MCP client launches the server as its stdio command. Below are two
generic examples; substitute your project paths.

Claude Desktop-style config (compiled mode — no Bun dependency):

```json
{
  "mcpServers": {
    "waystation": {
      "command": "C:\\Projects\\Waystation\\waystation.exe",
      "args": ["mcp"],
      "cwd": "C:\\Projects\\Waystation"
    }
  }
}
```

Source mode (Bun by full path, since it is not on `PATH`):

```json
{
  "mcpServers": {
    "waystation": {
      "command": "C:\\bun\\bin\\bun.exe",
      "args": ["run", "C:\\Projects\\Waystation\\src\\cli\\index.ts", "mcp"],
      "cwd": "C:\\Projects\\Waystation"
    }
  }
}
```

To bind a different ledger from a fixed working directory, add `--root` to
`args` (e.g. `["mcp", "--root", "C:\\other\\project"]`) or set the
`WAYSTATION_ROOT` environment variable for the server process.

## Verification and smoke checks

A fresh clone or rebuilt binary should pass the minimum CLI smoke checks first:

```ps1
.\waystation.exe --version
.\waystation.exe validate
.\waystation.exe task next
```

To confirm the MCP server itself is healthy, drive a stdio `initialize`
handshake and then call `validate_ledger`. A client that completes the
handshake and receives an `ok: true` `validate_ledger` result is talking to a
correctly-bound server. The server's `initialize` response advertises the
selected ledger root, so check it against the intended project.