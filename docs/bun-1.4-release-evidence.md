# Bun 1.4 Release Evidence

Waystation 0.5.0 makes Bun 1.4.0 the canonical local runtime after the
compatibility, embedded-dashboard, parallel-verification, and dependency-health
gates completed.

## Runtime identities

| Role | Version and revision | SHA-256 |
| --- | --- | --- |
| Canonical and versioned Bun 1.4.0 | `1.4.0+34cbb9a40` | `627D2E4775C24BDEDEE2CD7CCC18DCADAE061E5345274AB6E3C4C797927BFB8F` |
| Versioned Bun 1.3.14 rollback | `1.3.14+0d9b296af` | `0187F68D843F825A72ADA4A7ECA60DB896ED753759A7F8252EDCD31AC1BF1B9C` |

The versioned runtime copies are at `C:\bun\versions\1.4.0\bun.exe` and
`C:\bun\versions\1.3.14\bun.exe`. The canonical path is
`C:\bun\bin\bun.exe`.

## Waystation rollback

The ignored local bundle at `dist/waystation-0.4.0/` contains the 0.4.0
executable and the matching `package.json` and `bun.lock` from release commit
`4c8ccf1`. Git blob comparison confirms both metadata files exactly match that
commit. The executable reports `0.4.0`, is 99,918,336 bytes, and has SHA-256
`465B5620B9322695BAA5E985A75A0ED71716831ABE39BFCA04B3EF4BD81EB43B`.

To roll back the runtime, copy the versioned 1.3.14 executable to the canonical
path. To roll back Waystation source, restore release commit `4c8ccf1` (or the
bundle's paired manifest and lockfile) and use the bundled 0.4.0 executable.

## Release gates

- Bun dependency audit: zero known vulnerabilities.
- Frozen install: succeeds with no lockfile changes.
- Sequential suite: 245 tests pass across 7 files.
- Parallel stress: 10 consecutive passes, 2,450 test executions, zero failures.
- Standalone executable: embeds the dashboard and passes CLI, MCP, dashboard,
  API, asset, unrelated-directory, and path-with-spaces coverage.

The authoritative commands and artifact workflow are documented in
[release-packaging.md](release-packaging.md).
