# Release Packaging

Phase 10 is about making Waystation easy to rebuild, verify, and hand to another
local agent or project. This page records the repeatable local checks; it is not
a hosted release process.

## Fresh-Clone Smoke Checklist

Use this when validating a clean checkout, a local handoff bundle, or a machine
where you are not sure hidden state exists.

Assumptions:

- Windows PowerShell is the primary shell.
- Bun is installed at `C:\bun\bin\bun.exe`; it may not be on `PATH`.
- Canonical ledger state lives in `.waystation/*.json` and `events.jsonl`.
- `waystation.exe`, `index.sqlite`, and local distribution bundles are ignored
  build artifacts.
- Network access is only needed for dependency install or optional GitHub
  integration checks.

From a fresh checkout:

```ps1
cd C:\Projects\Waystation
$bun = "C:\bun\bin\bun.exe"

# Install dependencies and verify source mode.
& $bun install
& $bun test
& $bun run typecheck
& $bun run check

# Verify the ledger and generated artifacts from source.
& $bun run src/cli/index.ts validate
& $bun run src/cli/index.ts reindex
& $bun run src/cli/index.ts report --views
& $bun run src/cli/index.ts validate

# Rebuild and smoke-test the executable.
& $bun build --compile src/cli/index.ts --outfile waystation.exe
.\waystation.exe --version
.\waystation.exe validate
.\waystation.exe task next
.\waystation.exe brief --task task-phase10-fresh-clone-smoke --budget small
```

If `waystation.exe` already exists from a previous local build, still run the
source-mode checks before rebuilding. This confirms the checkout itself works
without relying on an old executable.

```ps1
& $bun run src/cli/index.ts validate
& $bun run src/cli/index.ts reindex
& $bun run src/cli/index.ts report --views
& $bun run src/cli/index.ts task next
```

Expected result:

- Tests, typecheck, Biome, and `validate` exit with code `0`.
- `reindex` reports task/issue/claim/message counts and rebuilds
  `.waystation/index.sqlite`.
- `report --views` regenerates `STATUS.md`, context files, and task views.
- `waystation.exe --version` prints the CLI version.
- `task next` either prints the next ready task or `No ready tasks.`.
- The final `git status --short` contains only intentional source, docs,
  ledger, or generated Markdown changes. It should not include
  `.waystation/index.sqlite` or `waystation.exe`.

Before committing a completed smoke pass, finish the active task, regenerate the
reports/views one final time, run `.\waystation.exe validate`, and commit the
task ledger changes with the code or documentation changes that made the pass
meaningful.
