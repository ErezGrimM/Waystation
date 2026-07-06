# Waystation

A local-first task, issue, prompt, handoff, and message ledger for coordinating
humans and AI coding agents across a codebase. Canonical state is plain JSON
files you can inspect, diff, and commit; there is no server or database to run.

> Formerly "AgentLedger". Some older docs still use that name.

## Status

V1 CLI (a walking skeleton) is working and dogfooded — Waystation manages its
own work in the `.waystation/` ledger in this repo. See
[docs/roadmap.md](docs/roadmap.md) for the phased plan.

## Requirements

- **[Bun](https://bun.sh)** (runtime + package manager + test runner). Node 22+
  also works as a fallback (SQLite falls back to `node:sqlite`), but Bun is the
  target.

> **This dev machine:** Bun is installed at `C:\bun\bin\bun.exe` and is **not on
> PATH**. Use the full path, e.g. `& C:\bun\bin\bun.exe test`, or add
> `C:\bun\bin` to PATH. Examples below assume `bun` is on PATH.

## Quickstart

```sh
bun install         # install dependencies
bun test            # run the test suite
bun run typecheck   # tsc --noEmit
bunx biome check .  # lint + format check

# run the CLI
bun run src/cli/index.ts --help
bun run src/cli/index.ts task next
```

## CLI

```sh
# tasks
waystation task next|ready|list|show <id>
waystation task claim|release|finish <id> --agent <name>

# briefs, validation, generation
waystation brief --task <id> [--json]
waystation validate
waystation reindex
waystation report [--views]

# agent messaging (async inbox)
waystation message post --thread <task|project> --from <agent> [--to <agent>] --body "..."
waystation message list --thread <id>
waystation inbox --agent <name> [--since <iso>]
```

(Invoke via `bun run src/cli/index.ts <...>`; a `waystation` bin is defined in
`package.json`.)

## Project layout

```
src/
  cli/index.ts     CLI entry (commander); thin wrappers over core
  core/            records, schema (zod), tasks, mutate, validate, brief,
                   messages, generate, store (the single write path), result,
                   paths, time
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
  (lock + atomic write + event append). The CLI, and later the MCP server and
  dashboard, all funnel through it — never write records directly.
- **zod is the schema authority**: every record validates on read.
- **Structured, coded errors** — see [docs/error-philosophy.md](docs/error-philosophy.md).
- Stays in its lane (see the spec's Non-Goals): not a full PM tool, not an agent
  runner, not a chat server, not a hosted service.

## Contributing (the dogfood loop)

Work is tracked in the ledger itself. A typical slice:

1. `waystation task next` → pick the next ready task.
2. `waystation task claim <id> --agent <you>`.
3. Implement until `bun test`, `bun run typecheck`, and `bunx biome check .` are green.
4. `waystation task finish <id> --agent <you>`, then `waystation reindex && waystation report`.
5. Confirm `waystation validate` is clean; commit.

## More

- [docs/roadmap.md](docs/roadmap.md) — phased plan and current state
- [docs/error-philosophy.md](docs/error-philosophy.md) — error/diagnostic model
- [agentledger-spec.md](agentledger-spec.md) — full specification
- [adr/](adr/) — stack and design decisions
