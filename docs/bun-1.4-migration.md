# Bun 1.4 compatibility migration

This document records the compatibility boundary for moving Waystation from
Bun 1.3.14 to exactly Bun 1.4.0. Optional Bun 1.4 product features are tracked
separately; this migration changes the runtime contract and proves existing
behavior first.

## Runtime and rollback locations

| Role | Path | Version and revision |
|---|---|---|
| Staged migration runtime | `C:\bun\versions\1.4.0\bun.exe` | `1.4.0+34cbb9a40` |
| Canonical pre-release runtime | `C:\bun\bin\bun.exe` | `1.3.14+0d9b296af` |
| Runtime rollback copy | `C:\bun\versions\1.3.14\bun.exe` | `1.3.14+0d9b296af` |
| Waystation rollback bundle | `dist/waystation-0.4.0/` | executable, `package.json`, and `bun.lock` |

The canonical `C:\bun\bin\bun.exe` stays on 1.3.14 until the Waystation 0.5.0
release gate. Development and verification during the migration use the staged
1.4.0 path explicitly.

## Package and lockfile contract

- `packageManager` pins `bun@1.4.0` for development and builds.
- `engines.bun` accepts `>=1.4.0 <1.5`; new Bun feature adoption must not drift
  ahead of the declared 1.4 compatibility window.
- `@types/bun` is pinned to `1.4.0` so runtime APIs and declarations stay in
  lockstep.
- Before changing package metadata, Bun 1.4.0 completed
  `bun install --frozen-lockfile` against the Bun 1.3.14 lockfile without
  changing either `package.json` or `bun.lock`.
- Regenerating after the type update retained `lockfileVersion: 1`. Bun 1.4 can
  create version 2 lockfiles for new projects, but this repository did not
  acquire that rollback incompatibility.
- A clean directory containing only the migrated `package.json` and `bun.lock`
  installed 133 packages with Bun 1.4.0 under `--frozen-lockfile`, without
  changing the lockfile. Bun 1.3.14 also accepted the migrated lockfile under
  `--frozen-lockfile`, so the retained v1 format has a tested rollback path.

`bun.lock` remains committed. Restore both `package.json` and `bun.lock` from
the 0.4.0 rollback bundle when rolling the source checkout back.

## Bun 1.4 breaking-change audit

The upstream [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4) and
[breaking-change inventory](https://github.com/oven-sh/bun/issues/28792) were
reviewed against Waystation's runtime surfaces.

| Area | Waystation exposure | Compatibility decision and evidence |
|---|---|---|
| Node.js 26 compatibility target | `node:*` file, path, crypto, and process APIs; `@types/node` | The project already uses `@types/node` 26. Run the complete suite under Bun 1.4 and retain the Node 22+ portable-core fallback contract. No native npm addon is part of canonical storage. |
| Lockfile defaults | `bun.lock`, dependency installation | Preserve and review the existing text lockfile. Frozen install must pass before and after metadata changes; rollback restores the matching manifest and lockfile together. |
| Compiled config autoloading | `bun build --compile` distribution | Waystation does not require a caller's `package.json` or `tsconfig.json` at runtime. Keep both disabled and smoke-test the compiled CLI from an unrelated working directory containing incompatible config files. `.env` behavior remains unchanged by this task. |
| `Bun.spawn` / `Bun.spawnSync` validation | CLI Vite process, Git operations, and integration tests | Every production invocation uses array-form arguments and valid string paths. Exercise Git status/mutations and child-process CLI tests under Bun 1.4. |
| `Bun.serve` validation and lifecycle | Hono dashboard server | The CLI converts the configured port to a number and uses a valid loopback hostname. Exercise dashboard routes, SSE, host/CSRF guards, and start/stop behavior under Bun 1.4. |
| `fetch` error and header semantics | GitHub import/export and dashboard development proxy | Existing mock-server tests cover success and coded failure paths. Preserve `github_api_error` mapping and CommandResult envelopes. |
| `bun:sqlite` close/query behavior | Disposable index backend | Reindex, repeated rebuild, close/reopen, ordering, inbox, and concurrent index tests must pass. Canonical JSON remains the source of truth. |
| `bun:test` matcher changes | Six test files | Run the full sequential suite under Bun 1.4. Parallel execution is deliberately deferred to `task-bun-1-4-parallel-verification`. |

No compatibility finding requires changing the single canonical write path or
the `CommandResult` error model. Any failure discovered by the verification
matrix must receive a regression test before this task completes.

## Verification

Run all migration checks with the staged binary:

```ps1
$bun = "C:\bun\versions\1.4.0\bun.exe"

& $bun --version
& $bun --revision
& $bun install --frozen-lockfile
& $bun test
& $bun run typecheck
& $bun run check
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views
& $bun build --compile src/cli/index.ts --outfile dist/bun-1.4-compat/waystation.exe
```

Smoke-test source CLI, MCP, dashboard APIs, SQLite index rebuild, concurrent
mutations, and the compiled CLI from an unrelated working directory. The
compiled smoke must demonstrate that caller `package.json` and `tsconfig.json`
files are not autoloaded.

On 2026-08-28, Bun 1.4.0 passed all 243 tests, typecheck, Biome, source sync and
project validation, and a live `Bun.serve` dashboard request. The compiled
90,262,528-byte executable passed version, validation, task selection, brief,
and live dashboard API smokes from a directory with deliberately invalid
caller `package.json` and `tsconfig.json` files. No compatibility code change
or new regression test was required.

## Deferred Bun 1.4 features

This compatibility slice does not adopt `Bun.JSONL`, `Bun.markdown`,
`Bun.Terminal`, `Bun.cron`, embedded dashboard assets, image processing, or
browser automation. Parallel verification and embedded dashboard assets have
their own dependency-gated tasks; the remaining APIs require separate product
decisions.
