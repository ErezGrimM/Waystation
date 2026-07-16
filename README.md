# Waystation

A local-first task, issue, prompt, handoff, and message ledger for coordinating
humans and AI coding agents across a codebase. Canonical state is plain JSON
files you can inspect, diff, and commit; there is no server or database to run.

> Formerly "AgentLedger". Some older docs still use that name.

## Status

Waystation is working and dogfooded: it manages its own work in the
`.waystation/` ledger in this repo. The V1 CLI, MCP server, local dashboard,
git/worktree context, GitHub Issues import/export, and Graphify brief enrichment
are implemented. See [docs/roadmap.md](docs/roadmap.md) for the phased plan and
current follow-up queue.

## Requirements

- **[Bun](https://bun.sh)** (runtime + package manager + test runner). Node 22+
  also works as a fallback (SQLite falls back to `node:sqlite`), but Bun is the
  target.

> **This dev machine:** Bun is installed at `C:\bun\bin\bun.exe` and is **not on
> PATH**. Use the full path, e.g. `& C:\bun\bin\bun.exe test`, or add
> `C:\bun\bin` to PATH. Examples below assume `bun` is on PATH.

## Quickstart

PowerShell on this repository:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun install
& $bun test
& $bun run typecheck
& $bun run check

# run the CLI from source
& $bun run src/cli/index.ts --help
& $bun run src/cli/index.ts task next

# build and smoke-test the standalone binary
& $bun build --compile src/cli/index.ts --outfile waystation.exe
.\waystation.exe --version
.\waystation.exe validate
```

If Bun is on PATH, the same flow is:

```sh
bun install         # install dependencies
bun test            # run the test suite
bun run typecheck   # tsc --noEmit
bun run check       # biome check .

# run the CLI
bun run src/cli/index.ts --help
bun run src/cli/index.ts task next

# build the standalone binary
bun build --compile src/cli/index.ts --outfile waystation.exe
```

## Running Waystation

There are three supported local execution modes. They all operate on the
`.waystation/` ledger in the current project root.

### Source checkout

Use this while developing or when you want the latest TypeScript code without
rebuilding the binary:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun run src/cli/index.ts task next
& $bun run src/cli/index.ts brief --task task-id --budget medium
```

The package also defines a script alias:

```ps1
& $bun run waystation -- task next
```

### Compiled binary

Use this when handing the project to another local agent or when you want a
single executable command surface:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun build --compile src/cli/index.ts --outfile waystation.exe
.\waystation.exe task next
.\waystation.exe brief --task task-id --budget small
```

Rebuild `waystation.exe` after any change under `src/`, `package.json`, or
`bun.lock`, and before asking another agent to rely on the compiled CLI. For
docs-only or ledger-only changes, a rebuild is optional unless you want to
refresh the handoff artifact.

Minimum binary smoke checks:

```ps1
.\waystation.exe --version
.\waystation.exe validate
.\waystation.exe task next
```

### MCP stdio server

Waystation exposes the same core behavior to coding agents over MCP stdio. Run
it from the project checkout so `findProjectRoot()` resolves the intended
ledger:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun run src/cli/index.ts mcp
```

Or, after rebuilding:

```ps1
.\waystation.exe mcp
```

A local MCP client should use one of those commands as the stdio server command
with `C:\Projects\Waystation` as the working directory. The server is local-only
and does not require a daemon or hosted service.

## CLI

```sh
# tasks
waystation task next|ready|list|show <id>
waystation task claim|release|finish <id> --agent <name>

# briefs, validation, generation
waystation brief [--task <id>] [--budget small|medium|large|full] [--json]
waystation validate
waystation reindex
waystation report [--views]

# agent messaging (async inbox)
waystation message post --thread <task|project> --from <agent> [--to <agent>] --body "..."
waystation message list --thread <id>
waystation inbox --agent <name> [--since <iso>]

# git/worktree context
waystation git status [--json]

# MCP and dashboard
waystation mcp
waystation dashboard [--dev] [--port 8787]

# optional GitHub Issues integration
waystation gh import --repo <owner/name>
waystation gh export --repo <owner/name>
```

Invoke via `bun run src/cli/index.ts <...>`, `.\waystation.exe <...>` after a
compiled build, or a `waystation` bin from `package.json` in an environment that
links package bins.

The `package.json` `bin` field points at the TypeScript source entrypoint for
environments that launch bins through Bun. The committed/local Windows handoff
artifact is `waystation.exe`, rebuilt with Bun's `--compile` command above.

## Project layout

```
src/
  cli/index.ts     CLI entry (commander); thin wrappers over core
  core/            records, schema (zod), tasks, mutate, validate, brief,
                   messages, git, Graphify, GitHub, generate, store (the single
                   write path), result, paths, time
  mcp/             MCP stdio server over the same core commands
  dashboard/       Hono server plus Vite/React local dashboard
  index/           bun:sqlite adapter (node:sqlite fallback) + task index
test/              bun:test suite
.waystation/       the ledger (see below)
docs/              roadmap.md, error-philosophy.md
adr/               architecture decision records
agentledger-spec.md   the full product spec
```

## The ledger (`.waystation/`)

```
config.json            project config
tasks/ issues/ prompts/ scopes/ claims/ handoffs/ decisions/ messages/  *.json records
events.jsonl           append-only event log
index.sqlite           disposable, rebuildable query index (gitignored)
reports/STATUS.md      generated
context/*.md           generated (active-work, blocked); summary.md is hand-authored
views/**/*.md          generated one-way from JSON
archive/               superseded records, kept for history
```

## Principles

- **JSON is canonical**; SQLite is a disposable index; Markdown is generated
  one-way for humans and never parsed back.
- **One write path**: all mutations go through `src/core/store.ts`
  (lock + atomic write + event append). The CLI, MCP server, and dashboard all
  funnel through it; never write records directly from those surfaces.
- **zod is the schema authority**: every record validates on read.
- **Structured, coded errors** — see [docs/error-philosophy.md](docs/error-philosophy.md).
- Stays in its lane (see the spec's Non-Goals): not a full PM tool, not an agent
  runner, not a chat server, not a hosted service.

## Contributing (the dogfood loop)

Work is tracked in the ledger itself. A typical slice:

1. `waystation task next` → pick the next ready task.
2. `waystation task claim <id> --agent <you>`.
3. Implement until `bun test`, `bun run typecheck`, and `bun run check` are green.
4. Rebuild after code changes:
   `bun build --compile src/cli/index.ts --outfile waystation.exe`.
5. `waystation task finish <id> --agent <you>`, then
   `waystation reindex && waystation report --views`.
6. Confirm `waystation validate` is clean; commit.

On this Windows checkout, replace `bun` with `& C:\bun\bin\bun.exe` when Bun is
not on PATH, or use `.\waystation.exe` after rebuilding.

## More

- [docs/roadmap.md](docs/roadmap.md) — phased plan and current state
- [docs/error-philosophy.md](docs/error-philosophy.md) — error/diagnostic model
- [docs/migration-guide.md](docs/migration-guide.md) — migrating from other task systems
- [docs/release-packaging.md](docs/release-packaging.md) — fresh-clone smoke checks and release packaging notes
- [agentledger-spec.md](agentledger-spec.md) — full specification
- [adr/](adr/) — stack and design decisions
