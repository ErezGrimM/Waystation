# Binary distribution notes and artifact naming

How compiled Waystation binaries should be built, named, stored, copied, and
handed to another local project or agent. This covers the local handoff
convention; there is no hosted release process. The build, version-bump, and
release flow lives in [docs/release-packaging.md](release-packaging.md); this
page is about the artifacts themselves.

## Canonical build command

```ps1
$bun = "C:\bun\bin\bun.exe"
& $bun build --compile src/cli/index.ts --outfile waystation.exe
```

`src/cli/index.ts` is the CLI entrypoint. The compiled output is a single
self-contained Windows executable (`waystation.exe`) with no Bun runtime
dependency. For environments that launch bins through Bun instead, the
`package.json` `bin` field (`waystation` → `./src/cli/index.ts`) serves the
same entrypoint from source.

Rebuild whenever `src/`, `package.json`, `bun.lock`, or the release version
changes (see the release checklist). After building, run the minimum smoke
checks:

```ps1
.\waystation.exe --version
.\waystation.exe validate
.\waystation.exe task next
```

## What is ignored, and why

The compiled executable and local distribution packages are **build artifacts**,
not tracked source. `.gitignore` covers them:

- `waystation.exe` — the latest local build, recreated with the build command
  above; never `git add -f`.
- `dist/` — local distribution bundles (see naming below).
- `.waystation/index.sqlite` — the disposable query index, rebuilt by
  `waystation reindex` / `sync`.
- Graphify output (`graphify-out/`) and other generated caches.

What **is** tracked: source, docs, ledger records, and generated ledger Markdown
(`STATUS.md`, context files, task views). Markdown is tracked so a fresh clone
stays inspectable, but it is generated one-way and never parsed back.

The ignored-artifact rule stands unless a release process explicitly decides
otherwise. If a binary must be committed (e.g. an intentionally versioned
deliverable), that is a deliberate, recorded decision — not the default.

## Artifact naming: latest vs versioned bundles

Two kinds of artifacts exist:

**Latest local build.** The plain `waystation.exe` in the repository root is the
current working binary for whoever has the checkout. It is overwritten on every
rebuild and is not versioned in its name; identify its version with
`.\waystation.exe --version`.

**Local distribution bundle.** When a binary is packaged for another local
project or agent, copy it into a named bundle under `dist/`. The convention is
`dist/waystation-latest/` for the current build, containing:

```
dist/waystation-latest/
  waystation.exe     rebuilt CLI binary
  README.txt         package manifest (version, contents, source paths)
  skills/waystation/ reusable agent skill for using Waystation in any project
```

If you need to keep multiple builds around, use a versioned name such as
`dist/waystation-0.2.0/` (or `waystation-0.2.0.exe` for a bare binary) and
record what changed in the bundle README. Keep `dist/waystation-latest`
pointing at the most recent build so a downstream consumer always has a
predictable source to copy from.

## The local skill/package convention

A distribution bundle pairs the binary with the reusable Waystation agent skill
(`skills/waystation/`). The skill lets an agent in any project detect a
`.waystation` ledger, find a project-local `waystation.exe` or `waystation`
CLI, and drive the standard commands without tribal knowledge.

The skill is not stored in this repository; it is authored and installed
elsewhere on the machine (the bundle `README.txt` records the exact installed
source, e.g. `C:\Users\User\.codex\skills\waystation`). Copy it from that
source of record when refreshing a bundle. The convention is generic — the
guidance and the skill itself must not hard-code a specific consumer project.
Refer to "the project using Waystation" or "the target repository", never to a
specific consumer project.

## Copy/install example for another local project

To give another local project a working Waystation binary, copy the bundle and
let the project's `AGENTS.md` (or its agent configuration) point at it. The
target project keeps the binary project-local; it does not install anything
globally.

```ps1
# From the Waystation checkout: refresh the current bundle.
$bun = "C:\bun\bin\bun.exe"
& $bun build --compile src/cli/index.ts --outfile waystation.exe
New-Item -ItemType Directory -Force dist\waystation-latest | Out-Null
Copy-Item waystation.exe dist\waystation-latest\waystation.exe -Force
# (refresh dist\waystation-latest\skills\waystation and README.txt as needed)

# Hand the bundle to another project.
Copy-Item -Recurse dist\waystation-latest <other-project>\.tools\waystation -Force
```

From the target project, verify the handoff:

```ps1
.\waystation.exe --version
.\waystation.exe validate   # from a directory inside that project's checkout
```

The project-local binary discovers the ledger by running from inside the
project (see [docs/mcp.md](mcp.md) for the same discovery rules for the MCP
server). A rebuilt binary supersedes an older copy in place; no uninstall step
is needed.

## See also

- [docs/release-packaging.md](release-packaging.md) — build, version bumps, the
  commit-aware release flow, and the fresh-clone smoke checklist.
- [docs/mcp.md](mcp.md) — launching the compiled binary as an MCP stdio server.
- [README.md](../README.md) — overview and CLI usage.