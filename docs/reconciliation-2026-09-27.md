# Started-work reconciliation — 2026-09-27

The owner requested merging all existing implementation work and completing the
started tasks. The integration branch is `codex/reconcile-started-work`, based on
`main` at `c759932`. This is a foundation release (0.6.0), not completion of the
entire Git/Hermes implementation plan.

## Integrated histories

| Source | Preserved tip | Scope |
| --- | --- | --- |
| `wt/w01-persistence` | `87b457d` | W01a–d: lock split, v2 intents, v1 recovery, record round-trip |
| `wt/w02-git-context` | `ee61994` | W02a–b: process adapter and commit object reader |
| `wt/w03-parser-registry` | `a24599b` | W03 parser and W08a registry/package foundation |
| `claude/search-performance-66790a` | `f866f4b` | Direct task lookup with compatibility fallback |

Each history was merged with a merge commit. Original commit messages and authors
remain intact. Uncommitted W02c source/test files were copied from the W02 worktree
and completed here; the original copies remain. W02d was completed as the last
part of the already assigned W02 package.

The W02 worktree moved from `.claude/worktrees/w02-git-context` to
`C:/Projects/Waystation-wt/w02-git-context`, following the recorded decision to
keep worktrees outside the repository. No Biome exclusions were added. Other
worktrees, agent briefs, branches, and the unrelated `.aionrs/` directory remain.

## Corrections during integration

- Git reads remove inherited `GIT_*` routing/configuration variables from the
  child environment, preserving the parent environment. Object lookup uses
  object-ID disambiguation, so hex-shaped branch names cannot redirect evidence.
- Bun now enforces the output cap while the child runs. Invalid limits fail with
  coded diagnostics. Bun and real Node fallback checks remain in the suite.
- UTF-8 BOMs remain part of commit descriptions. Non-UTF-8 descriptions retain
  original bytes alongside their decoded display text and encoding.
- Source identity uses the filesystem's canonical common-directory path without
  blanket Windows lowercasing. Junction, case alias, short-name, linked-worktree,
  separate-clone, moved-checkout, and bare-repository cases are covered.
- The immutable invocation context captures canonical ledger root, caller and
  binding separately. Relative evidence paths use the caller. Headless callers
  require absolute routes. No cwd/environment mutation or ledger-as-source guess
  is introduced. CLI/MCP reconciliation wiring remains W06.
- Legacy recovery validates every write and event before applying any record.
  Current intents reject reserved event bookkeeping and malformed payloads;
  pending intents cannot be silently replaced. Canonicalization failures refuse
  recovery. Valid unterminated JSON event tails retain the existing safe newline
  repair behavior.
- Registry facades sharing a state adapter serialize transactions. Persisted
  records are validated and isolated from returned mutable objects. Canonical
  roots are persisted, route/reference keys cannot collide on delimiters, and
  existing references survive retirement. Registry input and missing-ledger
  checks fail explicitly.
- Direct task lookup rejects path traversal before constructing filenames.
- The Python scaffold no longer pretends it can import the TypeScript registry.
  `register(ctx)` is importable and registers no runtime contributions. Placeholder
  REST routes were removed. The production profile-state bridge, cross-process
  config lock, native Monitor, and installation acceptance remain W08b–d.
- Release audit findings were resolved by updating only transitive `fast-uri`
  (3.1.5 → 3.1.8) and `qs` (6.15.3 → 6.16.0). The lockfile also synchronizes
  pre-existing root ranges with package.json. `bun audit --json` returns `{}`.

## Ledger reconciliation

The prior W02b claim was explicitly released by `codex-reconcile`, citing the
owner's request, and a fresh coordinator claim was created. The prior owner,
claim ID, worktree and timestamps remain in history. This was an administrative
maintenance operation through the normal store lock and mutation intent; it is
not the planned public transfer API, automatic expiry, or impersonation.

W02b, W02c, W02d and `task-reconcile-started-wave` are closed only after validation
and an implementation commit exists. That commit is attached as task evidence;
ledger closure is committed separately. Existing completed W01/W02a/W03/W08a
records retain their original evidence and receive the integration evidence.

## Verification and remaining scope

Release gates: full Bun suite, TypeScript, Biome, compiled CLI/dashboard build,
source and compiled project/view validation, whitespace check, dependency audit,
and Python scaffold import/registration. Exact final results are recorded in the
reconciliation task's completion message.

The merged pre-fix baseline passed 418 tests; the expanded suite has 427 tests.
Graphify is refreshed after source changes. The version authorities move together
to 0.6.0, and packageManager now reflects the approved Bun 1.4.1 gate runtime.

W04–W07, W08b–e, W09 and W10 remain backlog. No native Hermes installation or
end-to-end Monitor/worker claim is made. W10's future full-feature release must
choose the next minor after the version current at that time (currently 0.7.0).
The unified implementation plan remains the specification; this file records
integration evidence and does not introduce a competing implementation plan.
