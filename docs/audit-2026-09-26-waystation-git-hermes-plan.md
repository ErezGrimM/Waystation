# Independent audit — `docs/waystation-git-hermes-implementation-plan.md`

Reviewer: Hermes (independent pass) · 2026-09-26 · **read-only audit**

Scope: verify every load-bearing factual claim the plan makes about the three live systems it
depends on (Waystation 0.5.0 source, the installed Hermes build, the adjacent Hermes source
checkout), then judge whether the design can be frozen as W00.

Method: source reading + live reads only. No source change, no ledger mutation, no build, no
plugin load. The only file created is this document (untracked, not committed). `bun run build`
was deliberately **not** run — it rewrites the git-ignored `waystation.exe`.

**Resolution (2026-09-26):** applied to the plan document in place — the five must-fix items
(§4.1–§4.5), the corrected Kanban description (§4.2, whose replacement text was re-verified against
source: 9 of 9 statements hold), and the §5 precision items (Hermes storage mechanism named, cap
units pinned, Node fallback scoped, diagnostic codes enumerated, claim CLI context noted, wont_do
readiness noted). The unverified gates in §6 remain unproven, and no implementation is authorized
by either document.

## 1. Verdict

**GO — with corrections.** Proceed to the §18 task-list conversion *after* applying the five
must-fix items in §4; they are baseline/ownership/precision corrections, not architectural ones.

No finding invalidates the architecture, the state table (§7.2), the persistence design (§9), or
the authority model (§3.2). The plan's failure semantics are unusually complete, and 20 of the 20
verifiable claims about current code held up — several with useful precision beyond what the plan
states.

Nothing found rises to STOP. A STOP would require one of: a lifecycle invariant the plan's state
table contradicts, an unrecoverable-persistence assumption that is false, an ownership cycle, or a
Hermes mechanism the integration depends on that does not exist. None of those is present.

## 2. Verified — Waystation source claims (§3.3, §5–§7)

`bun test` baseline and versions are in §7.

| # | Plan claim | Evidence | Verdict |
|---|---|---|---|
| 1 | `TaskRecord.commits` is a `string[]`; unknown task fields preserved | `src/core/schema.ts:79` (`commits: z.array(z.string()).default([])`), `.passthrough()` at `:82` | ✅ |
| 2 | Attachment compares reference strings and may write/emit events on repeated input | `src/core/mutate.ts:239-261`: `refs = normalizeCommits(commits)` dedupes only *within the input*; `refs.length===0` returns early, but passing an already-present ref yields a real `updated_at` bump + `task.commits_attached` event | ✅ exactly right |
| 3 | `finishTask` completes unclaimed work, rejects already-done | `mutate.ts:388` (rejects `done`), `:393-399` (claim optional; owner checked only when one exists) | ✅ |
| 4 | `claimTask` accepts explicit Git context internally; MCP surface lacks per-call forwarding | `mutate.ts:264-270, 296-306` (`ClaimGitContext{caller,branch,worktree}`); MCP `claim_task` inputSchema is `{id, agent}` only (`src/mcp/server.ts`, claim block) | ✅ |
| 5 | `reopenTask` retains commits, clears `closed_at` | `mutate.ts:176` | ✅ |
| 6 | `createHandoff` records context, does not transfer ownership | `src/core/handoff.ts:37-79` — writes a record + `handoff.created`; no claim/status write | ✅ |
| 7 | Recovery treats "any event with the mutation id" as proof the whole batch landed | `src/core/store.ts:266-279` (`eventAlreadyAppended` scans for the mutation id), `:297-299` (skips the whole event list) → a crash after event 1 of 4 permanently drops 3 and unlinks the intent | ✅ **the single most important claim in the plan, and it is correct** |
| 8 | `withLedgerLock` does cleanup/recovery before the callback | `store.ts:346-352` (`sweepOrphanTmp` then `recoverMutationIntentUnlocked` then `fn()`) | ✅ |
| 9 | Existing reads do not supply a coherent revisioned snapshot | no `snapshot`/`detail`/`thread`/`history` command exists (`src/cli/index.ts`); reads are per-collection (`tasks.ts`, `messages.ts`, `handoff.ts:82`) | ✅ |
| 10 | "CLI `task create` exists; older AGENTS text is stale" | `src/cli/index.ts:190-203` | ✅ |
| 11 | The §7.1 preconditions map to existing diagnostics | `src/core/result.ts` already catalogs `multiple_active_claims:113`, `claim_status_divergence:234`, `duplicate_id:53`, `invalid_commit_ref:310`, `lock_contended:222` | ✅ — §14 should reference these by code |
| 12 | Seven task statuses incl. `review` and `wont_do` | `schema.ts:46-54` | ✅ |
| 13 | zh. `addTaskCommits` merges without duplicating existing strings but still rewrites | `mutate.ts:230-237` | ✅ |
| 14 | `commit_evidence` absence remains valid | field does not exist today; `TaskRecord.passthrough()` keeps unknown fields, so an additive field round-trips safely | ✅ |
| 15 | Additive audit events are compatible | nothing in `src/core/**` branches on `event.type`; `validate.ts:505-515` checks `events.jsonl` as JSONL only | ✅ `task.git_reconciled` needs no consumer change |
| 16 | Ledger resolution order `--root` → `WAYSTATION_ROOT` → upward discovery, never silent fallback | `src/core/paths.ts:35-63`; missing ledger throws `LedgerResolutionError` (`:52`) | ✅ |
| 17 | MCP keeps a fixed ledger root | `src/mcp/server.ts:47` `buildServerAtRoot(resolveLedgerRoot({explicitRoot: root}))` | ✅ |
| 18 | Derived SQLite is disposable, views/reports are tracked | `src/index/db.ts`, `src/core/generate.ts`, `src/core/sync.ts` | ✅ |
| 19 | No Git-hook / CI interference | no `.github/workflows`, no active hooks in `.git/hooks` | ✅ (and see risk R2) |
| 20 | `graphify`/sync/validate command list in §16 | `graphify update .` is an external tool; `sync --views`, `validate --project --views`, `verify:fast`, `build` all exist in `package.json` / `src/cli/index.ts:660-663` | ✅ except the ordering defect in §4.5 |

Two claims the plan makes are *more* precise than it claims, and should be tightened rather than
loosened:

- `getGitState` returns an **abbreviated** head (`git rev-parse --short HEAD`, `src/core/git.ts:85`).
  §7.4's `git.head` cannot come from it; W02 must own the full-OID read.
- `runGit` is private and hardcodes `Bun.spawnSync` (`git.ts:25-32`), so under the sanctioned
  Node fallback `getGitState` throws outright. §5.1's portable adapter is therefore required, not
  optional polish.

## 3. Verified — Hermes claims (§3.3, §11–§13)

All re-verified at the revision now checked out, `59004a6235` (see §4.1).

| # | Plan claim | Evidence | Verdict |
|---|---|---|---|
| 1 | Native extensions use `@hermes/plugin-sdk` | alias → `apps/desktop/src/sdk/index.ts` (`vite.config.ts:221`, `tsconfig.json:21`); enforced by `apps/desktop/eslint.config.mjs:19-30` ("plugins speak `@hermes/plugin-sdk` (+ react), never `@/…`") and `src/contrib/runtime-loader.ts:211-269` | ✅ — stronger than the plan says: runtime-loaded `plugin.js` may import **only** `@hermes/plugin-sdk` and `react*`, so W08's build step must not emit bare imports |
| 2 | One package can carry `plugin.yaml` + `desktop/plugin.js` + `dashboard/manifest.json` + `plugin_api.py` | `plugins/kanban/{dashboard/manifest.json,dashboard/plugin_api.py,dashboard/dist/index.js}`; `plugins/hermes-achievements/dashboard/**`; `hermes_cli/plugins_cmd_catalog.py:347` reports `has_desktop_half` for `desktop/plugin.js`; `hermes_cli/plugin_validate.py:522` lists loadable entrypoints | ✅ (runtime loading itself is untested — §6) |
| 3 | `ctx.rest` is the plugin's own backend namespace | `website/docs/developer-guide/desktop-plugin-sdk.md:59,1260,1281-1285,1430-1440`; live use `apps/desktop/src/plugins/kanban/{plugin.tsx:88,api.ts:2}` (`/api/plugins/<id>/…`), profile-aware, rejects `..` | ✅ |
| 4 | `ctx.call_mcp` needs a per-plugin server allowlist | `hermes_cli/plugins.py:509-538` (`PermissionError` unless the server is in `plugins.entries.<id>.mcp_allowlist`), `:564-573` (default-deny) | ✅ |
| 5 | `ctx.call_mcp` caps output and its outer success ≠ inner success | `plugins.py:540` `_MCP_RESULT_CHAR_CAP = 65536`; `:543-562` truncates **by characters** with `"… [truncated]"` + `truncated: True`, and builds `{ok, result}` from the *transport* envelope | ✅ exact |
| 6 | Native plugin tool handlers receive session/task context | `model_tools.py:872-875` (`handle_function_call(..., task_id, tool_call_id, session_id, turn_id, api_request_id, user_task)`); `tools/registry.py:899-903` injects optional context kwargs by signature inspection | ✅ mechanism exists — durability is the open gate (§6) |
| 7 | MCP connections are profile/server scoped and adoptable with matching identity; trust is per consuming profile | `tools/mcp_tool_registration.py:57-72` (`_server_key`, `_record_scope_trust`, "an adopting profile records its own policy") | ✅ |
| 8 | Per-project MCP entries are configurable | `hermes_cli/config_defaults.py:516` (`mcp_servers` definitions vs `mcp` runtime) | ✅ |
| 9 | Native Monitor can contribute panes/sidebar and has scoped disposal | `apps/desktop/src/sdk/index.ts:1244-1287` (tab registration + disposer), `:1405-1409` (`ctx.onDispose`), `:1909-1952` (session-row areas, sidebar nav contributions, "clear it on dispose") | ✅ |
| 10 | Plugin backends get a session/profile event bridge | `hermes_cli/plugin_events.py` (public event bridge for `plugin_api.py` / slash commands) | ✅ |
| 11 | Unassigned Kanban cards are not safely passive; creation is not idempotent | **stale** — `create_task(idempotency_key=…)` returns the existing non-archived task (`hermes_cli/kanban_db.py:1260,1274-1275`, column `:897`); `kanban.default_assignee` defaults to `""` (`config_defaults.py:1886`) with unassigned rows bucketed as `skipped_unassigned` (`kanban_db_dispatch.py:2363,2378`) | ❌ see §4.2 |
| 12 | `ctx.rest` route fingerprint specialness ("cwd alone is not part of the fingerprint") | not reproducible as stated; the connection-scope key is `(server_name, profile scope)` (`mcp_tool_registration.py`), and per-project separation comes from **distinct server names with explicit args**, which is what §12.2 actually relies on | ⚠️ reword — the conclusion holds, the stated reason does not |

## 4. Must fix before W00 freezes contracts

### 4.1 Re-pin the Hermes baseline; the plan's §3.3 is stale and self-contradictory

The plan says the adjacent checkout was `9796235…` (desktop package version 0.17.3) and warns not
to assign that version to the running app.

Today: the checkout is `59004a62356f3a4697ab0fe8ad5086d2b405e2a6` — **byte-identical to the
`commit` in the running app's `resources/install-stamp.json`** — working tree clean, and
`apps/desktop/package.json` reads `0.0.0` (root `package.json` `1.0.0`), matching the plan's
"app.asar reports 0.0.0" note. Reflog confirms the move:
`9796235… (HEAD@{2}) → merge origin/main → 59004a6235 (HEAD@{0})`.

Consequences to fix in the document:

1. `§3.3` must be re-pinned to `59004a6235` (built 2026-09-25T13:55:07Z, `dirty: false`) and the
   0.17.3 warning deleted — it describes a tree the runner no longer has.
2. The plan's own sentence "the inspected SDK/contribution and MCP transport/scope/registration
   files matched the stamped revision" is **impossible as written**: at inspection the checkout
   was `9796235` while the stamp named `59004a6`, and 9 days / **7804 commits** separate them
   (`git rev-list --count 9796235..HEAD`). What it can honestly say is what this audit did: the
   named mechanisms were re-verified at `59004a6` on 2026-09-26 and all hold.
3. Keep and elevate the plan's own "Recheck build identity at implementation and rollout" — it is
   now proven necessary, not defensive.

### 4.2 Delete the stale Kanban justification (Q21 / §3.3)

Q21's *decision* (no native-card projection in this release) stands on scope grounds and needs no
upstream excuse. Its stated *reason* is now wrong on both counts:

- card-creation idempotency exists (`idempotency_key`, above);
- default-assignment risk is opt-in, not default (`kanban.default_assignee` is `""`; unassigned
  rows are reported as `skipped_unassigned`).

Fix: state the deferral as scope, and derive from the current code any residual concern (e.g. an
operator who *has* set `default_assignee` **would** get auto-dispatch on projected cards) instead
of carrying a stale upstream finding into W00's frozen contracts.

**Resolved and re-verified (2026-09-26).** The plan's §3.3 now records current Kanban behavior
instead of the stale limitation, and its replacement text was checked statement by statement
against source at `59004a6` — **9 of 9 hold**:

| Plan statement | Evidence |
|---|---|
| statuses are `triage, todo, scheduled, ready, running, blocked, review, done, archived` | `kanban_db.py:103` (`VALID_STATUSES`, exact set) |
| creation is idempotent on `idempotency_key` | `kanban_db.py:1325-1332` (newest non-archived row with the key is returned) |
| unassigned ready rows are not spawned; only `kanban.default_assignee` auto-assigns | `kanban_db_dispatch.py:2355-2367` + `_apply_default_assignee:2105-2133` (row mutated, event `assigned`, source `kanban.default_assignee`); config default `""` (`config_defaults.py:1886`) |
| the review lane never auto-assigns | `kanban_db_dispatch.py:2374-2378` (unassigned review row → `skipped_unassigned`) |
| non-spawnable assignees are bucketed separately | `kanban_db_dispatch.py:2011-2018` ("control-plane lanes that pull via `claim_task`"), `:1641-1691` (`kanban.dispatch_profiles` per-home allowlist) |
| the dispatcher never claims `triage` | the claim path is `status IN ('running','ready','review')` (`kanban_db.py:1425`); no `triage` reference exists in the dispatcher module |
| `blocked` is not a parking state | `recompute_ready:2134-2157` promotes non-sticky `blocked`; sticky = explicit `kanban_block` or a breaker trip stamped `sticky` (`_has_sticky_block:2076-2101`, `:3220-3268`) |
| no creation hook fires; `kanban_task_claimed` fires in the dispatcher before a spawn | hook catalog in `hermes_cli/plugins.py:158-177` |

Two refinements this audit applied to that text:

1. `skipped_nonspawnable` is now described in the source's own terms (a non-profile assignee — the
   code's case is a control-plane lane that pulls work itself via `claim_task` and would otherwise
   loop ready→crash→ready) rather than an unverified concrete example.
2. `triage` was **not** overstated as a parking state: the dispatcher never claims it, but it is the
   queue an explicit `hermes kanban specify|decompose [--all]` sweeps (`hermes_cli/kanban.py:1253-1316`,
   `kanban_decompose.py:342` lists `status="triage"`), rewriting the root and creating child cards
   routed to `default_assignee`. Parking against automatic dispatch is not inertia against an
   operator-initiated sweep — and that distinction is exactly what a future projection decision
   needs.

### 4.3 Name the owner of the claim round-trip defect (§6 last bullet)

§6 requires that unknown fields on task records **and raw claim records** survive writes, then
hedges with "do not rely on a schema that strips unknown claim fields". That is not a caution; it
is a live defect in the current code and it has no W owner:

- `TaskRecord` has `.passthrough()` (`schema.ts:82`); **`ClaimRecord` does not** (`schema.ts:184-195`).
- `loadClaims` parses every claim through `ClaimSchema.safeParse` (`store.ts:375`), and every claim
  mutation writes the parsed object back (`releaseTask` `mutate.ts:361-365`, `finishTask` `:418-423`).

So any claim mutation silently drops unknown keys today. Exposure is currently latent, not lost
data: all **78** claim files on disk carry zero unknown keys (checked directly). Fix: add
`.passthrough()` to `ClaimRecord` (or make claim round-trips raw-preserving), assign it to W01's
"record-path preservation helpers", and list it as a W04 dependency — otherwise W04's transfer
intent becomes the first writer to drop a field it did not own.

### 4.4 The read-only lock policy contradicts the current lock entry point (§9.1)

§9.1 says the read policy must not "create ledgers", but `withLedgerLock` does
`mkdirSync(paths.ledger, {recursive: true})` **before** acquiring the lock (`store.ts:335`), and
`sweepOrphanTmp` fires once per process on first acquisition (`store.ts:97-102`). Fix: state that
W01 splits a read-path acquisition (lock only) from the mutation acquisition (mkdir + sweep +
recover), and that a missing ledger still fails first via `resolveLedgerRoot`'s
`LedgerResolutionError` (`paths.ts:52-63`) — which §10.3 already requires.

### 4.5 §16's run order is wrong, verified today

The documented order runs `bun test` before any dashboard build. `test/compiled-dashboard.test.ts`
compiles the CLI and needs `src/dashboard/client/dist`, so it fails with
`ModuleNotFound resolving "src/dashboard/client/dist" (entry point)`. Measured baseline:
**283 pass / 1 fail** (`Ran 284 tests across 8 files. [24.15s]`).

Fix: put `bun run dashboard:build` (or `bun run build`) ahead of `bun test`, record the 283/1
baseline as the A09 "existing behavior preserved" reference, and note that A16/A17 compiled
acceptance requires a fresh `bun run build` (the on-disk `waystation.exe` is from 2026-08-28, older
than current source; it is git-ignored).

## 5. Should fix — precision and unnamed mechanisms

1. **Registry storage (§11.2).** The plan invents a "versioned plugin configuration store" and a
   "short plugin-config lock" without naming what Hermes already provides: `ctx.state` — "this
   plugin's profile-scoped durable JSON state facade" (`plugins.py:285-288`) — and
   `ctx.get_config`/`set_config` → `plugins.entries.<id>.settings` in `config.yaml`
   (`plugins.py:269-283`). Decide explicitly which one holds project registrations; `ctx.state` is
   the profile-scoped durable mechanism, and §11.2's "scope access to the selected local Hermes
   runtime/profile route" is exactly its semantics.
2. **Registry edits vs prompt cache (§17.3).** Configuring per-project `mcp_servers` entries
   changes the tool surface; Hermes notes that a reload "rebuilds the tool surface and INVALIDATES
   the provider prompt cache" (`config_defaults.py:517-520`). Say whether project registration is
   additive at runtime (`/reload-mcp` cost) or batched, and state that each project server name
   must be added to `plugins.entries.<id>.mcp_allowlist` (default-deny, `plugins.py:564-573`).
3. **§12.4 budget units.** "48 KiB" against a 65,536-**character** cap with a truncation marker:
   measure the budget on the envelope-inclusive serialized string, and treat `truncated: true` as
   an unknown-outcome signal even when `ok` is true.
4. **"Git-context-dependent reads" (§4.2) is undefined.** Enumerate them. As designed, §10's
   snapshot/detail/thread/history schemas carry no caller context and evidence is already stored,
   so no read *needs* it — say so, or list the exceptions.
5. **Name the duplicate-route control (§4.3/A13).** Hermes already scopes MCP registration per
   profile/server (`tools/mcp_tool_scope.py`, `mcp_tool_registration.py::_server_key`). Cite it
   instead of "configure the managed agent toolset", so W07 and W10 do not each invent one.
6. **Scope the Node fallback claim (§5.1/Q14/A01).** The Node path is real but partial:
   `node:sqlite` fallback in `src/index/db.ts`, while `src/core/git.ts:26` and the dashboard/serve
   path (`src/cli/index.ts:1202`, `src/dashboard/server.ts`) are Bun-only. Scope "Node fallback
   coverage" to CLI core + W02's adapter and say the dashboard is out of it.
7. **§14 cross-reference table.** Prose already says "reuse existing codes"; make it a
   code-by-code table for the families that already exist (`multiple_active_claims`,
   `claim_status_divergence`, `invalid_commit_ref`, `no_git_claim_match`, `ambiguous_git_claim`,
   `duplicate_id`, `lock_contended`) so W06 cannot invent synonyms.
8. **§12.2 claim-surface note.** The CLI already exposes claim git context
   (`task claim --branch/--worktree`, `src/cli/index.ts:348-349`, consumed at `mutate.ts:202-212`
   via the `caller` override). Say the CLI path is complete and only MCP forwarding plus the
   adapter's bound caller worktree are new — W02 should extend that contract, not add a parallel
   one.
9. **§13.1 "Display `wont_do` distinctly from `done`"** is consistent with the code, but note
   `dependencySatisfied` treats `wont_do` as satisfied (`tasks.ts:21-23`) — the Monitor must show
   that, or a "blocked by" list will look wrong to the user.

## 6. Unverified gates — do not treat as proven by this audit

These are the plan's own §12.5 gates; the mechanism exists in source but was not exercised, and I
did not load a plugin or start a session to test any of it:

1. `session_id`/`task_id` **durability and distinctness** as seen by a plugin tool handler
   (injection is verified; stability across restart/compression and separation of parallel
   sessions in one profile is not).
2. Runtime loading of a package carrying **both** a native desktop half and `plugin_api.py`.
3. Dispatch of **N project-bound MCP servers** through `ctx.call_mcp` with per-project args.
4. Anything about the installed runtime's behaviour beyond source reading — no plugin was loaded,
   no MCP route was called.

## 7. Baseline evidence (2026-09-26)

| Item | Value |
|---|---|
| Waystation | `package.json` 0.5.0; CLI version `src/cli/index.ts:53`; MCP server version `src/mcp/server.ts:52` — three authorities agree |
| Waystation HEAD | `9907de9` ("docs: detail Bun-native migration task scopes"), 13 commits ahead of `origin/main` |
| Working tree | clean except `.aionrs/` and the plan document itself (both untracked) |
| Ledger | 97 tasks — 78 `done`, 19 `todo`, 0 `ready`/`in_progress`; 78 claim files, 0 with unknown keys |
| Test baseline | `bun test` → 283 pass / 1 fail (see §4.5); `C:/bun/bin/bun.exe` present, not on PATH |
| Hermes build | install-stamp commit `59004a62356f3a4697ab0fe8ad5086d2b405e2a6`, built `2026-09-25T13:55:07.298Z`, `dirty: false`, `distribution: desktop-app` |
| Hermes checkout | HEAD identical to the stamp, clean; `apps/desktop/package.json` `0.0.0`, root `1.0.0` |
| Upstream drift | 7804 commits between the plan's inspected checkout and the running build |

## 8. Delivery risks (not defects — decisions the plan leaves open)

- **R1 — Q1 couples the release to its least-proven slices.** "First release = reconciliation +
  Hermes worker integration + read-only Monitor" makes a W07/W08 platform gate failure block the
  reconciliation core, which is the only part with a consumer today. Declare either an independent
  version for the Hermes package or the condition under which Q1 re-opens.
- **R2 — Acceptance evidence has no runner.** 18 acceptance groups, including cross-process crash
  injection (A08), two workers on one project connection (A12), and installed-Hermes/compiled
  acceptance (A16/A17) — against 8 test files, no CI, and no git hooks. State who runs them and
  whether CI lands in this release.
- **R3 — Critical path is under-labelled.** W01 → W04 → W06 → W09 carries the risk; W08 is the
  largest slice. §17.1's sequence is sound but §15 does not distinguish critical-path work from
  parallel work, which is what the §18 conversion needs to order tasks by.

## 9. What this audit did not do

No source edit, no ledger mutation, no `git commit`, no `bun run build`, no plugin load, no MCP
call, no Hermes restart. The plan's own stage gate ("design only") remains in force; the five
must-fix items are document-and-ownership corrections and do not authorize implementation.
