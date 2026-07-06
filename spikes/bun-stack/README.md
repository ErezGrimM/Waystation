# Bun Stack Spike

This is a disposable spike for testing whether Bun is viable for Waystation.

It mirrors `spikes/deno-stack/` where possible and checks:

- TypeScript execution without a separate build step
- npm imports for `commander`, `yaml`, `zod`, `hono`, and MCP SDK
- current `.waystation/tasks/*.yaml` loading
- Zod validation
- `bun:sqlite` index creation
- a tiny local dashboard route
- `bun build --compile`
- repo discovery from the current working directory in compiled binaries

Run from this directory:

```powershell
bun install
bun run version
bun run list
bun run reindex
bun run mcp:smoke
bun run compile
.\waystation-spike.exe task list
.\waystation-spike.exe reindex
```

The SQLite file is written to `.waystation/index-bun-spike.sqlite` and can be
deleted after the spike.

Waystation should discover the project from the current working directory and
walk upward to `.waystation`, which works in both interpreted and compiled
modes.

## Results On 2026-07-06

Environment:

- Local Bun binary installed under `.tools/bun/`.
- Bun version: `1.3.14`.
- Platform tested: Windows x86_64.

Passed:

- `bun install`
- `bun run version`
- `bun run list`
- `bun run reindex`
- `bun run mcp:smoke`
- `bun run compile`
- `waystation-spike.exe task list`
- `waystation-spike.exe reindex`

Findings:

- The official MCP TypeScript SDK imported and registered a stdio server under
  Bun.
- `bun:sqlite` created and queried `.waystation/index-bun-spike.sqlite`.
- `bun build --compile` produced a working Windows executable.
- The compile was very fast in this spike.
- The compiled Windows executable was about 99 MB, roughly comparable to the
  Deno spike.
- Bun did not require the explicit runtime permission workarounds Deno needed.

Design implications:

- Bun remains a strong stack candidate for Waystation.
- Bun had the smoothest local developer loop in this spike.
- Compiled executable size is not meaningfully smaller than Deno for this
  dependency set.
