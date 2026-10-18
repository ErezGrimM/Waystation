# Finished-work integration audit — 2026-10-18

## Scope and disposition

Starting main: `76eb72e` (0.9.0). All local and fetched origin refs were
inventoried. Only two branches contained commits not reachable from main;
all other retained worktree branches were already integrated. No old worktree,
untracked experiment, or agent checkout was deleted. The pre-existing October 10
Monitor message and its event were preserved as historical evidence.

| Commit | Audited change | Disposition |
|---|---|---|
| `def6279` | Named missing arguments and lifecycle transition guidance | Integrated |
| `0e848fa` | CLI ledger-location and branch help | Integrated; settle guidance corrected |
| `f64d5d8` | Untracked scope warning | Integrated; Git reads made portable and bounded |
| `16256b1` | File attribution and actor-specific ledger commits | Integrated with staged-file, actor-key and candidate-validation fixes |
| `dab15c2` | Co-writer attribution, pending merges, settle, locking | Integrated; unsafe shared-writer commits refused and settle writes disabled |
| `c410047` | Union merge attributes and merge guidance | Integrated; attributes are a conflict aid, not a lifecycle correctness guarantee |
| `83f7a85` | Avoid recommending config reset to repair attributes | Integrated |
| `4fe496c` | Hermes SDK REST/backend bridge | Integrated; not evidence of successful native verification |
| `a9163e3` | Merge main into the bridge branch | Integrated ancestry; was not a merge of the PR into main |

Local integration merges: `e973580` (ledger changes), `03e8ff7` (bridge).
Release version: 0.11.0 in package, CLI parser, MCP metadata and rebuilt binary.

## Findings corrected before publication

1. `ledger status` only inspected unstaged/untracked differences. Staged task
   records could disappear from an actor commit while their events were included.
   The staged difference is now included; a regression preserves the real index.
2. An actor such as `__proto__` could collide with the owner map's prototype.
   The map now has no prototype and the test uses that exact actor.
3. A shared task's current bytes could be committed with only one writer's
   lifecycle events. Shared-writer files are now refused. Every actual candidate
   is exported using its temporary index and validated before its branch ref is
   published; missing dependencies are covered by a regression.
4. Settle removed/restored canonical records one at a time and independently
   reset history, allowing incomplete ledgers and interruption hazards. Writes
   are refused with `ledger_settle_unsafe`. `--dry-run` remains read-only under
   the read lock. Transactional restoration is an explicit ready follow-up.
5. New Git commands had no process bounds and the scope check depended directly
   on Bun. They now use the existing portable, bounded process adapter. New ledger
   operations return coded envelopes on failure. Task dependency reads use the
   authoritative TaskRecord schema.
6. The lint command discovered a nested agent worktree configuration. Check and
   format now explicitly target the existing configured source/test/integration
   directories, preserving coverage without traversing another checkout.
7. Dependency audit reported eight advisories. In-range lockfile remediation
   updated SDK 1.31.0, hono 4.13.7, ip-address 10.7.1, proxy-addr 2.0.8 and
   source-map-js 1.2.2. No major dependency upgrade was introduced.

## Reconciled maintenance tasks

The following thirteen tasks still said todo although `0527560` implemented
their fixes. Current source and regression coverage were reviewed; closure
records retain that original implementation commit, plus the integration release
commit where relevant. This is reconciliation, not a claim of thirteen new fixes.

| Task suffix (all prefixed `task-`) | Evidence |
|---|---|
| dashboard-lexical-sorts | `byInstantThenId` in dashboard task/claim sorting; dashboard tests |
| error-mapping-hygiene | MCP ZodError and coded unsafe-issue-id paths; MCP/core tests |
| gh-import-force-flag | CLI forwards force; skip/refresh and help regressions |
| git-status-changed-count | Distinct changed-file set; MM/AM regression |
| index-lock-discipline | CLI/dashboard lock wrappers; concurrent locked rebuild test |
| init-force-semantics | Help/README and preservation regression |
| mutation-intent-recovery-doc | Manual recovery procedure and diagnostic hint |
| ranking-offset-aware | Parsed-instant comparator; in-memory/index ordering tests |
| record-unknown-fields | TaskRecord passthrough, ADR-0009, round-trip test |
| remove-writeclaim-dead-code | No source/test references to writeClaim |
| repair-metric-consistency | Physical-line count regression |
| sse-event-coverage | Core append publishes; direct-core-call SSE regression |
| sweep-tmp-coverage | Root and derived-directory sweep coverage |

SSE evidence concerns the in-process event hub, as the task's acceptance test
specifies. It does not prove cross-process filesystem notifications.

## Remaining-work map

After reconciliation: 25 open tasks, comprising 3 ready, 2 blocked and 20 todo.
No full-plan Git/Hermes task is promoted by merging the POC bridge.

| Tasks | Status / next requirement |
|---|---|
| `task-ledger-settle-transactional` | Ready: coherent, crash-recoverable restoration before re-enabling writes |
| `task-guard-branch-ledger-commits` | Ready: enforce coordination-checkout ledger commits; shared-root discovery alone is insufficient |
| `task-merged-work-still-open` | Ready: read-only warning from commit reachability and task evidence |
| `task-poc-project-monitor` | Blocked: demonstrate native configured-project views, refresh and failure states; review selected-thread refresh/race handling during this work |
| `task-poc-agent-workflow` | Blocked: observe ready, claimed and done states in the native Monitor; prior real Hermes MCP execution remains valid partial evidence |
| `task-poc-value-review` | Todo: owner compares native POC with existing dashboard and explicitly chooses stop, bounded iteration or scoped MVP |
| `task-w04a-additive-schema` | Deferred: versioned commit-evidence schema |
| `task-w04b-reconcile-core` | Deferred: evidence attachment/closure core operation |
| `task-w04c-lifecycle-guard` | Deferred: reopened-work completion protection |
| `task-w04d-transfer` | Deferred: explicit atomic claim transfer |
| `task-w05a-snapshot` | Deferred: coherent versioned snapshot |
| `task-w05b-bounded-reads` | Deferred: paginated detail, thread and history |
| `task-w06a-reconcile-surfaces` | Deferred: reconciliation CLI/MCP and worker context |
| `task-w06b-transfer-surfaces` | Deferred: transfer CLI/MCP |
| `task-w06c-read-surfaces` | Deferred: read surfaces and generated worker contracts |
| `task-w06d-diagnostics-contract` | Deferred: remaining diagnostic families |
| `task-w07a-binding-store` | Deferred: durable worker identity and binding lifecycle |
| `task-w07b-forwarding` | Deferred: verified native MCP forwarding |
| `task-w07c-worker-gates` | Deferred: host capability probes before production workers |
| `task-w08b-plugin-backend` | Deferred: production shared profile-state bridge; reuse the bounded POC read bridge where suitable |
| `task-w08c-native-monitor` | Deferred: production views, polling and lifecycle handling; existing manual POC is not a no-op placeholder |
| `task-w08d-package-assembly` | Deferred: assembled production package and isolated installation |
| `task-w08e-live-session-assessment` | Deferred, optional: live Hermes session view feasibility |
| `task-w09-integration-acceptance` | Deferred: assembled installed-host end-to-end acceptance |
| `task-w10-release` | Deferred: production integration rollout; this 0.11.0 release does not satisfy it |

## Verification

Final release checks used Bun 1.4.1:

- `bun test`: 484 passed, zero failures across 25 files (final run: 73.20 seconds).
- `bun run typecheck`: passed.
- `bun run check`: 80 files checked, clean.
- `python -B -m unittest test.hermes_plugin_api_test`: four passed.
- `bun audit`: no vulnerabilities in 162 packages after remediation.
- `bun run build`: passed; source CLI and compiled executable both report 0.11.0.
- `sync --views` and `validate --project --views`: zero errors, two historical warnings.
- Compiled `ledger settle --json` refuses writes with the documented diagnostic.
- `graphify update .` and `git diff --check`: completed successfully.

Native Hermes was not launched or reconfigured by this audit. Existing
two orphan-thread warnings refer to historical demo messages and are retained;
inventing a production demo task would misrepresent their provenance.
