# Release Packaging

Phase 10 is about making Waystation easy to rebuild, verify, and hand to another
local agent or project. This page records the repeatable local checks; it is not
a hosted release process.

## Release Checklist

Use this checklist for a phase completion or major bug-fix release. Run it from
the repository root in Windows PowerShell. Keep the release task claimed until
the implementation/version commit exists so the task can record that commit.

### 1. Confirm the release inputs

```ps1
cd C:\Projects\Waystation
$bun = "C:\bun\bin\bun.exe"
$task = "task-release-id"
$agent = "agent-name"
$version = "0.1.0" # replace with the approved target

git status --short
.\waystation.exe task show $task
.\waystation.exe message list --thread $task
```

- Start from an understood worktree. Do not discard unrelated user or agent
  changes to make it clean.
- Confirm every dependency of the release task is done.
- Confirm the task is claimed by `$agent` and its thread contains the current
  verification status.
- For a phase completion or major bug fix, increment the minor version and
  reset the patch component (for example, `0.0.3` to `0.1.0`).

### 2. Update every version authority

Set the same version in all three locations:

1. `package.json` — top-level `version`;
2. `src/cli/index.ts` — Commander `.version(...)`;
3. `src/mcp/server.ts` — `McpServer` constructor metadata.

Verify that no location was missed:

```ps1
Select-String -Path package.json,src\cli\index.ts,src\mcp\server.ts `
  -SimpleMatch -Pattern $version
```

Do not bump only the CLI string. Package consumers, `waystation --version`, and
MCP clients must observe one release version.

### 3. Refresh derived project state and verify source mode

After code changes, update the local knowledge graph before final inspection.
`sync --views` is the consolidated equivalent of canonical validation,
reindexing, `report --views`, and project freshness validation; the explicit
read-only validation afterward records a clear final health check.

```ps1
graphify update .

& $bun test
& $bun run typecheck
& $bun run check
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views

git diff --check
git status --short
```

Inspect the diff. Expected tracked changes are the intended source/docs,
canonical ledger records, and regenerated Markdown. `.waystation/index.sqlite`,
Graphify output, and `waystation.exe` are local ignored artifacts.

### 4. Rebuild and smoke-test the ignored binary

Always rebuild after changing `src/`, `package.json`, `bun.lock`, or the release
version. The executable is a local handoff artifact and is intentionally not
committed.

```ps1
& $bun build --compile src/cli/index.ts --outfile waystation.exe

$actualVersion = (.\waystation.exe --version).Trim()
if ($actualVersion -ne $version) {
  throw "binary version $actualVersion does not match expected $version"
}

.\waystation.exe validate --project --views
.\waystation.exe task next
.\waystation.exe brief --task $task --budget small

git check-ignore -v waystation.exe
git check-ignore -v .waystation\index.sqlite
```

The final two commands must show the ignore rules. Do not use `git add -f` for
the binary or disposable index. Rebuild the binary locally whenever another
agent needs a current executable.

### 5. Commit the implementation before finishing the task

Review and stage only intentional files, then create the implementation/version
commit while the release task is still `in_progress`:

```ps1
git diff
git status --short
git add <intentional-source-doc-ledger-paths>
git diff --cached --check
git commit -m "release: prepare Waystation $version"

$implementationCommit = (git rev-parse HEAD).Trim()
```

This ordering is deliberate. A task cannot store the SHA of the commit that is
currently being constructed. The implementation commit therefore comes first;
the task closure and generated status changes are recorded in a second commit.

### 6. Finish the task with commit awareness

Post the verification result, finish the task with the implementation SHA, and
refresh the ledger after the status/claim mutation:

```ps1
.\waystation.exe message post --thread $task --from $agent --kind update `
  --body "Release $version verified. Implementation commit: $implementationCommit."

.\waystation.exe task finish $task --agent $agent --commit $implementationCommit
# --commit-head is equivalent only when HEAD is still the intended commit.

.\waystation.exe sync --views
.\waystation.exe validate --project --views
.\waystation.exe task show $task

git diff --check
git status --short
```

Confirm `task show` reports `done`, the expected commit reference, and no active
claim. Stage only the resulting task, claim, message, event, report/context, and
task-view changes, then commit the bookkeeping:

```ps1
git add <intentional-task-ledger-and-generated-paths>
git diff --cached --check
git commit -m "chore: close $task"
```

### 7. Final handoff

```ps1
git log -2 --oneline
git status --short
git push
```

The implementation/version commit and ledger-closure commit must both be
present. The worktree should contain no unexplained tracked changes; ignored
local artifacts may remain. Post the pushed commit ids in the task or project
thread when another agent or human will take over.

## Fresh-Clone Smoke Checklist

Use this when validating a clean checkout, a local handoff bundle, or a machine
where you are not sure hidden state exists.

Assumptions:

- Windows PowerShell is the primary shell.
- Bun is installed at `C:\bun\bin\bun.exe`; it may not be on `PATH`.
- Canonical ledger state lives in `.waystation/*.json` and `events.jsonl`.
- `waystation.exe`, `index.sqlite`, Graphify output, and local distribution
  bundles are ignored build artifacts. Generated ledger Markdown is tracked;
  `report --views` refreshes the complete tracked output set.
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
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views

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
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views
& $bun run src/cli/index.ts task next
```

Expected result:

- Tests, typecheck, Biome, `sync --views`, and project validation exit with
  code `0`.
- `sync` reports task/issue/message counts plus total and active claims,
  rebuilds `.waystation/index.sqlite`, and verifies a consistent canonical
  snapshot.
- `sync --views` regenerates `STATUS.md`, context files, and task views.
- `waystation.exe --version` prints the CLI version.
- `task next` either prints the next ready task or `No ready tasks.`.
- The final `git status --short` contains only intentional source, docs,
  ledger, or regenerated Markdown changes. It should not include
  `.waystation/index.sqlite` or `waystation.exe`.

Before committing a completed smoke pass, follow the release checklist's
commit-aware closure flow: commit the meaningful implementation first, finish
the active task with that SHA, run `sync --views`, validate, and commit the
resulting ledger bookkeeping separately.
