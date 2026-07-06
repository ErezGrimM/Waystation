# Deno Stack Spike

This is a disposable spike for testing whether Deno is viable for Waystation.

It checks:

- TypeScript execution without a separate build step
- npm imports for `commander`, `yaml`, `zod`, `hono`, and MCP SDK
- current `.waystation/tasks/*.yaml` loading
- Zod validation
- `node:sqlite` index creation
- a tiny local dashboard route
- `deno compile`
- repo discovery from the current working directory in compiled binaries

Run from this directory:

```powershell
deno task version
deno task list
deno task reindex
deno task mcp:smoke
deno task compile
.\waystation-spike.exe task list
.\waystation-spike.exe reindex
```

The task aliases use explicit Deno permissions such as
`--allow-read=../../.waystation` instead of short aliases so the command shape
is clear and portable. `commander` also needs scoped env access for color
detection: `CLICOLOR_FORCE`, `FORCE_COLOR`, and `NO_COLOR`. The npm `yaml`
package probes `LOG_TOKENS` and `LOG_STREAM`, so the spike grants those too.

The SQLite file is written to `.waystation/index-spike.sqlite` and can be
deleted after the spike.

Compiled Deno binaries run modules from a temporary bundle path, so Waystation
must discover the project from `Deno.cwd()` and walk upward to `.waystation`
rather than relying on `import.meta.url`.

## Results On 2026-07-06

Environment:

- Local Deno binary installed under `.tools/deno/`.
- Deno version: `2.9.1`.
- Platform tested: Windows x86_64.

Passed:

- `deno task version`
- `deno task list`
- `deno task reindex`
- `deno task mcp:smoke`
- `deno task compile`
- `waystation-spike.exe task list`
- `waystation-spike.exe reindex`

Findings:

- The official MCP TypeScript SDK imported and registered a stdio server under
  Deno.
- `node:sqlite` created and queried `.waystation/index-spike.sqlite`.
- `deno compile` produced a working Windows executable.
- The compiled executable was about 96 MB in this spike because it embedded
  npm dependencies, including the MCP SDK and Hono-related transitive deps.
- Deno permissions need to be explicit. `commander` probes color-related env
  vars, and npm `yaml` probes logging env vars.
- Project discovery in compiled binaries must start from `Deno.cwd()`, because
  `import.meta.url` points into Deno's temporary compiled bundle.

Design implications:

- Deno remains a strong stack candidate for Waystation.
- Prefer Deno-native or small dependencies where possible to reduce compiled
  binary size and permission friction.
- Keep the real CLI able to locate `.waystation` by walking upward from the
  current working directory.
