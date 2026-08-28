# Bun 1.4 Verification

Waystation uses two verification profiles under Bun 1.4.0. The fast profile is
for the development loop; the sequential profile remains the authoritative
release evidence.

## Fast development checks

Run the isolated test files in parallel:

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun run test:parallel
```

Run parallel tests, TypeScript, and Biome concurrently:

```ps1
& $bun run verify:fast
```

`test:parallel` expands to `bun test --parallel=4 --isolate`.
`verify:fast` uses `bun run --parallel` only for the independent test,
typecheck, and lint processes. Package scripts invoke the same Bun executable
that launched them through `$npm_execpath`, preventing an older rollback binary
from being selected by a nested script.

The Windows migration stress run completed 10 consecutive parallel passes:
245 tests across 7 files per run, 2,450 total test executions, and no failures.
Test fixtures use unique temporary roots and dynamic server ports; the suite
does not use retries or relaxed assertions to obtain that result.

## Authoritative release checks

Run these sequentially before a release:

```ps1
& $bun test
& $bun run typecheck
& $bun run check
```

Parallel success is a fast signal, not a substitute for the sequential test
gate or ledger validation in [release-packaging.md](release-packaging.md).

## Dependency health

These Bun 1.4 commands are safe read-only diagnostics:

| Command | Purpose | Exit behavior |
| --- | --- | --- |
| `bun audit` | Query the advisory database for installed dependencies. | Nonzero when advisories are found. |
| `bun audit fix --dry-run` | Preview compatible advisory remediations without changing files. | Nonzero while vulnerabilities would remain. |
| `bun dedupe --check` | Report whether the lockfile contains removable duplicate resolutions. | Nonzero when deduplication is available. |
| `bun pm licenses` | Inventory dependency licenses; add `--json` for machine-readable output. | Zero when the inventory succeeds. |

The corresponding mutating commands are `bun audit fix`,
`bun audit fix --latest`, and `bun dedupe`. Review their proposed package and
lockfile changes before running them, then repeat install, audit, tests, and
build verification. Do not put network-dependent audit calls in the offline
test suite.

The migration audit initially found 15 advisories (7 high, 7 moderate, 1 low).
The dry run identified 14 patch-fixable advisories; the remaining React Router
advisory requires its locked package family to move together. Dependency
remediation was treated as a release gate, not an ignored warning. The reviewed
fix updated six transitive lockfile resolutions and moved `react-router-dom`
with `react-router` from 7.18.1 to 7.18.2. The post-remediation audit reports
zero known vulnerabilities, `bun dedupe --check` reports no duplicates, and
the license inventory succeeds.

See Bun's documentation for
[audit](https://bun.sh/docs/pm/cli/audit),
[dedupe](https://bun.sh/docs/pm/cli/dedupe), and
[package-manager utilities](https://bun.sh/docs/pm/cli/pm).
