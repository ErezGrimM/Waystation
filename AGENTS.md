# Agent Guide to Waystation

Everything a coding agent needs to know to contribute to this project.

## Environment

```ps1
# Bun is at C:\bun\bin\bun.exe — NOT on PATH
$bun = "C:\bun\bin\bun.exe"
& $bun test                # run test suite
& $bun run typecheck       # tsc --noEmit
& $bun run check           # biome check .
& $bun run format          # biome format --write .
& $bun run src/cli/index.ts --help

# Compiled binary (rebuild after changes)
& $bun build --compile src/cli/index.ts --outfile waystation.exe
```

## Architecture

```
CLI (src/cli/index.ts) ──┐
MCP (src/mcp/server.ts) ─┼── thin wrappers ──► src/core/ ──► .waystation/ JSON ledger
Dashboard (src/dashboard/)┘                     (single write path)
                                                  src/core/store.ts
```

**Layers must stay thin.** Every feature lives in `src/core/` first, then gets surfaced through CLI, MCP, and dashboard as thin wrappers. Never duplicate logic across layers.

## The single write path (non-negotiable)

All mutations MUST go through `src/core/store.ts`:
- `withLedgerLock(root, fn)` — acquire lock → run fn → release
- `writeJsonAtomic(file, value)` — atomic write (tmp + fsync + rename)
- `appendEventUnlocked(root, event)` — append to events.jsonl (must hold lock)

Never write canonical JSON files directly from CLI, MCP, or dashboard code. Use the core mutation functions: `claimTask`, `releaseTask`, `finishTask`, `createHandoff`, `postMessage`, `createIssue`.

## Error model

Every return value uses the `CommandResult<T>` envelope:
```ts
{ ok: boolean; data: T | null; errors: Diagnostic[]; warnings: Diagnostic[] }
```

- New error codes go in `src/core/result.ts` → `CODES` catalog
- Every code has: `severity` ("error"|"warning"), `message`, `hint`, `retryable`
- `diag(code, opts?)` builds a diagnostic; `toResult(data, diags)` builds a result
- Catch `MutationError` / `RecordError` → map their `.code` → `diag(code, ...)`
- Never leak raw stacks to callers

## Schema authority

`zod` in `src/core/schema.ts` defines every record type. Always:
```ts
const parsed = SomeSchema.safeParse(readJsonFile(file));
if (!parsed.success) throw new RecordError(file, "schema: ...", "schema_invalid");
```

## Testing

Tests use `bun:test`. Key patterns:

```ts
// Create a throwaway ledger with task fixtures
function fixtureRoot(records: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-test-"));
  tmpRoots.push(root);
  const tasksDir = join(root, ".waystation", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (const rec of records) {
    writeFileSync(join(tasksDir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  }
  return root;
}

// For tests that need a real git repo (claim context, branch detection):
// Create fixture inside the project root so git commands work
function gitFixtureRoot(records) {
  const root = join(import.meta.dirname, "..", `waystation-test-git-${...}`);
  tmpRoots.push(root);
  // ... same pattern, but inside the project directory
}

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});
```

## Dogfooding workflow

Waystation manages its own tasks. Every change follows this loop:

1. **Pick next task**: `.\waystation.exe task next`
2. **Claim it**: `.\waystation.exe task claim <id> --agent <you>`
3. **Implement** until all checks are green
4. **Finish**: `.\waystation.exe task finish <id> --agent <you>`
5. **Regenerate**: `.\waystation.exe reindex` && `.\waystation.exe report --views`
6. **Validate**: `.\waystation.exe validate`
7. **Commit and push**

If another agent is working on the same scope, coordinate via:
- `.\waystation.exe message post --thread <task-id> --from <you> --body "..."` 
- `.\waystation.exe inbox --agent <their-name>` to check for messages

## Versioning

- Every phase completion or major bug fix: **bump by +0.1**
- Update in: `package.json`, `src/cli/index.ts` (`.version(...)`), `src/mcp/server.ts` (`McpServer` constructor)
- Rebuild: `& $bun build --compile src/cli/index.ts --outfile waystation.exe`

## Build & verify checklist

Before marking a task done, run ALL of these:

```ps1
& $bun test              # all tests green
& $bun run typecheck     # tsc --noEmit clean
& $bun run check         # biome check clean (if import ordering: bun run format, then fix manually)
.\waystation.exe validate # ledger ok
```

## Common gotchas

- **`loadTasks` is in `records.ts`, not `tasks.ts`.** `tasks.ts` exports `nextTask`, `readyTasks`, `isActionable`.
- **Hono route handlers**: use `_c` for unused context params to avoid biome lint.
- **`noUncheckedIndexedAccess`** is on — array/record access returns `T | undefined`. Use `!` or fallbacks.
- **Import ordering**: biome enforces: node builtins → npm packages → core modules (`./`). Fix with `bun run format` first, then manually reorder if needed.
- **`withLedgerLock` is async** even when the callback is sync. `await` it.
- **Dashboard API routes** return `CommandResult` as JSON via the `json()` helper in `server.ts`.

## Key files

| File | Purpose |
|------|---------|
| `src/core/store.ts` | Single write path (lock, atomic write, event) |
| `src/core/schema.ts` | zod schemas for all record types |
| `src/core/result.ts` | `CommandResult`, `Diagnostic`, code catalog |
| `src/core/brief.ts` | `buildBrief`, `resolveTaskFromGitClaim` |
| `src/core/mutate.ts` | `claimTask`, `releaseTask`, `finishTask` |
| `src/core/messages.ts` | `postMessage`, `inbox`, `threadMessages` |
| `src/core/git.ts` | `getGitState` (branch, worktree, status) |
| `src/core/paths.ts` | `findProjectRoot`, `ledgerPaths` |
| `src/cli/index.ts` | CLI entry (commander) |
| `src/mcp/server.ts` | MCP tools over core |
| `src/dashboard/server.ts` | Hono API routes over core |
| `src/dashboard/client/` | Vite + React SPA |
| `docs/roadmap.md` | Phased plan + current state |
| `docs/error-philosophy.md` | Error/diagnostic model |
| `test/skeleton.test.ts` | Main test suite |
