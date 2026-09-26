# Waystation Git reconciliation and Hermes integration

Detailed implementation plan · revised 2026-09-26

Planning baseline: Waystation 0.5.0; native Windows Hermes build identified below.

Stage: design only. No implementation tasks, source changes, installations, or agent runs are authorized by this document alone.

Audit revision 2026-09-26: corrected after the independent read-only audit recorded in
[docs/audit-2026-09-26-waystation-git-hermes-plan.md](audit-2026-09-26-waystation-git-hermes-plan.md) —
Hermes baseline re-pinned to the running build commit, the stale Kanban rationale replaced with measured
current behavior, defect and ownership gaps assigned, and the verification run order corrected.

## 1. Outcome and consistency assessment

Waystation remains the canonical project ledger. Agents can explicitly reconcile a local Git commit with a task, attach verified evidence, and optionally close work they own. Hermes workers use that ledger through a session-aware adapter. A native Hermes Monitor displays the same tasks, claims, evidence, issues, messages, and handoffs without creating Hermes Kanban cards.

The user's answers are compatible. They describe different responsibilities rather than competing task systems. The earlier draft accumulated several ambiguities; this rewrite resolves them as follows.

| Apparent conflict or design gap | Final interpretation |
| --- | --- |
| Owner-only closure versus preserving existing finish commands | Strict owner/evidence/retry rules apply to the new reconciliation operation. Existing finish/status/attachment commands keep their public semantics. The managed Hermes workflow selects reconciliation for completion; this is not a universal enforcement change to every Waystation writer. |
| Any agent can attach evidence, but only the owner can close | Attachment and closure are distinct operations. A failing close request never falls back to attachment. |
| Any actor can repeat a completed request | A validated no-change response observes an already-satisfied state. It grants no permission to close open work or take ownership. |
| Reopened tasks need new evidence, but both commit descriptions must remain | Retain earlier references and messages. A commit used to close an earlier lifecycle cannot close a later one. Evidence retention is separate from eligibility to close. |
| Preserve descriptions versus unavailable historical Git objects | Every newly verified attachment captures its message. Legacy descriptions are preserved or recovered only when identity/source are known and objects are available. Missing historical descriptions remain explicitly unavailable; they cannot be reconstructed from a hash alone. |
| Tolerant trailers versus explicit-only closure | Match task-marker keys without case sensitivity and ignore markers outside the final trailer block. Inside that block, unsupported Waystation-Close remains an error. Only the command's close input authorizes closure. |
| Read-only Monitor versus working agents and agent chat | Monitor views do not mutate the ledger. Agents post messages and perform work through worker tools. Plugin configuration/bindings are local operational state, not canonical task records. |
| Shared Hermes profile versus distinct worker worktrees | Share a project-bound MCP connection, not its caller context. The adapter validates a binding and supplies request-local context on every call. |
| Multiple registered projects versus arbitrary evidence repositories | The plugin registers destination ledgers. An explicitly supplied local Git evidence source needs no registration and never changes the destination ledger. |
| Removing a project from the Monitor versus preserving workers | Removal retires/hides a registration and prevents new bindings. Existing bindings retain its immutable routing information until drained. Hard deletion is refused while referenced; no worker is silently retargeted. |
| Stuck-agent takeover versus stopping the old worker | An audited claim transfer changes ledger ownership. Stopping the previous process is a separate coordination action and must happen before successor edits. No filesystem fencing is promised. |
| No-change requests versus recovery | A request that is already satisfied produces no new writes/events. Entering the mutation path can still recover an earlier interrupted mutation. Read-only Monitor calls never perform that recovery. |
| Full first release versus optional live sessions | Reconciliation, shared-profile worker access, and the complete baseline Monitor ship together. Agent discussions are required. Live Hermes transcripts/activity are assessed afterward and do not block the baseline. |
| One plan with no overlap versus shared package dependencies | Each deliverable has one owner. The plugin foundation, worker adapter, Monitor, and final assembly are separate dependency slices of one package; there is no circular task dependency or second registry. |

No additional product-choice question is required to make these decisions compatible. Technical acceptance gates remain: Hermes context propagation, actual plugin loading, recovery fault tests, and Windows packaging must be proved during implementation. Failure at a gate blocks the affected rollout; it does not authorize a different product architecture.

## 2. Approved decisions

The identifiers retain the discussion's numbering. These are final choices, not a menu of implementation alternatives.

| Decision | Integrated requirement |
| --- | --- |
| Q1 | First release includes reconciliation core/CLI/MCP, Hermes worker integration, and native read-only Monitor. |
| Q2 | Closure requires explicit CLI --close or MCP close:true. Commit messages never trigger closure. |
| Q3 | A new reconciliation close requires a consistent in_progress task with exactly one active claim owned by the actor. User/coordinator may explicitly transfer ownership after stopping the old worker. |
| Q4 | A consistent done task with the same verified, already-associated evidence returns successful no_change for any retry actor. |
| Q5 | One task may have evidence from several repositories. Any explicit local Git source is permitted; no source registry is required. |
| Q6 | Accept full or unambiguous abbreviated hexadecimal commit hashes only; persist full lowercase object IDs. |
| Q7 | Preserve unresolved unrelated historical references, warn, and proceed. Refuse identity ambiguity affecting the requested evidence. |
| Q8 | Any agent may attach verified evidence to consistent open or done tasks, including another agent's task. Refuse wont_do. New evidence on done requires attach-only. |
| Q9 | Real additions update updated_at. Preserve original closed_at and completed-claim timestamps. No-change updates nothing. |
| Q10 | Task-marker keys are case-insensitive. Ignore markers outside the final trailer block. Reject malformed, duplicate, conflicting, and unsupported directives inside it. |
| Q11 | Recover only unambiguous interrupted mutations. Refuse corrupt/ambiguous recovery state with repair guidance; do not rewrite history. |
| Q12 | Existing attachment, finish, and status behavior remains compatible. Shared persistence fixes still apply. |
| Q13 | No preview/dry-run mode in this release. Separate decisions from writes so a later preview is possible. |
| Q14 | Windows-first: full source/compiled checks and focused Node fallback coverage. macOS/Linux are not release blockers or new support claims. |
| Q15 | Roll out to local Waystation and the selected native Hermes installation. DuckBrain deployment is excluded. |
| Q16 | Earlier completion commits cannot close reopened work. Retain original and follow-up commits with their descriptions and lifecycle history. |
| Q17 | Target the native Windows desktop plugin interface, not the web dashboard frontend. |
| Q18 | Include tasks, claims, evidence, issues, messages, handoffs, and agent-to-agent discussions first. Assess live Hermes sessions afterward if feasible. |
| Q19 | One integration package at integrations/hermes/ inside this repository. Generic ledger behavior remains in src/core/. |
| Q20 | Poll every five seconds while visible, support manual refresh, stop hidden-page polling, back off failures, and label last-good data stale. |
| Q21 | Native Hermes Kanban projection/backend replacement is deferred. No bridge or passive-card feasibility implementation in this release. The deferral is a scope decision, not an upstream limitation; §3.3 records current Kanban dispatch and card-creation behavior. |
| Q22 | Native Windows; multiple destination projects and a Monitor switcher from the start. Workers may share a Hermes profile through a session-aware adapter. |

## 3. Scope and architecture

### 3.1 Included capabilities

1. Verified commit attachment and optional task closure through one core operation.
2. Audited, explicit claim transfer for a stopped/stuck worker.
3. Durable repository-qualified evidence with preserved commit descriptions.
4. Correct recovery of interrupted record writes and event batches.
5. Generic coherent snapshots and bounded detail/thread/history reads.
6. A shared-profile Hermes worker adapter with explicit session bindings.
7. One native Hermes Monitor, project registry, package, and installation procedure.
8. Compatibility tests, integration acceptance, documentation, and coordinated release.

Excluded: automatic completion, background Git scanning, automatic takeover, Git commit/push/fetch/sync inside reconciliation, Git hooks, remote evidence fetching, force-close, multi-task commit selection, Monitor write controls, native Kanban cards, a replacement Hermes backend, another audit service, and a second canonical task/chat database.

A project switcher does not imply an all-project aggregate board. Read-only agent discussions do not imply a reply composer. Workstation/profile configuration does not imply a new autonomous dispatcher.

### 3.2 Authority and data flow

~~~text
Hermes sessions sharing a profile
        |
        v
Session-aware worker adapter [W07]
  binding -> project MCP route + actor + caller worktree
        |
        v
Project-bound Waystation MCP [W06]
        |
        v
Waystation core [W01-W05] <--- CLI / existing dashboard wrappers
        |
        v
Canonical .waystation records + events
        |
        v
Snapshot/detail core -> CLI read surface
        |
        v
Hermes plugin read adapter -> native Monitor [W08]

One plugin project registry serves W07 and W08.
The Monitor's selected project never controls worker routing.
~~~

| State | Authority |
| --- | --- |
| Tasks, claims, evidence, issues, messages, handoffs, events | Canonical Waystation ledger |
| Git object identity, message, parents | Explicitly selected local Git repository |
| Project registrations and MCP route mapping | One local plugin configuration store |
| Session/worker binding and generation | Plugin execution metadata referencing a registration |
| Hermes sessions and live transcript, if later exposed | Hermes |
| Display selection, filters, last-good display cache | Monitor presentation state |
| SQLite index, reports, generated views | Derived Waystation data; explicitly regenerated |

Canonical mutations go through src/core/store.ts, using its lock, atomic file writer, and recoverable mutation intent. CLI, MCP, dashboard, and Python plugin code must not write canonical JSON directly.

### 3.3 Planning evidence and its limits

Waystation was inspected at version 0.5.0, checkout commit 9907de9:

- TaskRecord keeps commits as a string array and preserves unknown task fields.
- Existing attachment compares reference strings and may emit writes/events on repeated input.
- finishTask can complete unclaimed work and rejects already-done work. Q12 preserves that contract.
- claimTask accepts explicit Git context internally; the MCP surface needs per-call forwarding.
- reopenTask retains commits and clears closed_at.
- createHandoff records context; it does not transfer ownership.
- The current recovery code treats any event with a mutation ID as proof that the whole event batch was appended. A crash partway through a batch can therefore lose the remaining events.
- withLedgerLock currently performs recovery/temporary-file cleanup before the callback.
- Existing reads do not supply the complete coherent snapshot required by the Monitor.
- CLI task create exists; older AGENTS text claiming otherwise is stale.

Relevant files:
[src/core/store.ts](../src/core/store.ts),
[schema.ts](../src/core/schema.ts),
[mutate.ts](../src/core/mutate.ts),
[records.ts](../src/core/records.ts),
[git.ts](../src/core/git.ts),
[paths.ts](../src/core/paths.ts),
[tasks.ts](../src/core/tasks.ts),
[messages.ts](../src/core/messages.ts),
[result.ts](../src/core/result.ts),
[CLI](../src/cli/index.ts), and [MCP](../src/mcp/server.ts).

The running Hermes executable was found at:

~~~text
C:/Users/User/AppData/Local/hermes/hermes-agent/apps/desktop/release/win-unpacked/Hermes.exe
~~~

Its resources/install-stamp.json records build commit
59004a62356f3a4697ab0fe8ad5086d2b405e2a6, built 2026-09-25, with `dirty: false` and
`distribution: desktop-app`. Its packaged app.asar reports package version 0.0.0. Use the
build commit as identity. The executable's 40.10.2 version is Electron's, not the Hermes
release.

Re-pinned 2026-09-26: the adjacent source checkout at that Hermes installation is now at
the same commit as the build stamp (59004a6235…), with a clean working tree; its
apps/desktop/package.json reports 0.0.0 and its root package.json 1.0.0. Source and running
build match today.

An earlier draft inspected that checkout at
9796235822b89e08597a402dad045b5b4464e474 (desktop package version 0.17.3, 2026-09-16) — 7804
commits behind the stamped build. That source version must never be assigned to the running
app, and no finding taken from that tree may be attributed to the stamped revision. Every
Hermes mechanism this plan relies on was re-verified at 59004a6235 on 2026-09-26, and each
finding below carries the evidence for it.

Installed-source findings:

- Native extensions use @hermes/plugin-sdk (a vite/tsconfig alias to apps/desktop/src/sdk/index.ts), including page/sidebar contribution points and scoped disposal/timers. Runtime-loaded plugin code may import only @hermes/plugin-sdk and `react*`; the SDK is the plugin's whole language and that fence is enforced by lint and by the runtime import allowlist.
- One Hermes package can include plugin.yaml, desktop/plugin.js, and dashboard/manifest.json plus plugin_api.py, and the plugin catalog reports such a package as having a desktop half. That dashboard directory supplies backend routes; it does not require a web frontend.
- ctx.rest provides the plugin's own backend namespace (`/api/plugins/<id>/…`), is profile-aware, and rejects path traversal.
- Native plugin tool handlers receive session/task context (task_id, session_id, tool_call_id, turn_id) as signature-inspected optional kwargs. ctx.call_mcp uses Hermes's existing MCP client and requires a per-plugin server allowlist (default-deny).
- MCP connections are profile/server scoped and can be reused across sessions or adopted across profiles with matching connection identity; trust is recorded per consuming profile, never per connection.
- Per-project isolation comes from distinct MCP server names carrying explicit per-project command arguments, not from the caller's cwd: the inspected route/scope key is (server name, profile scope), and cwd is not part of it.
- ctx.call_mcp has an outer envelope and truncates above 65,536 characters — characters, not bytes — appending a truncation marker. Its outer success is not proof of inner Waystation success.
- Plugin backends have a session/profile event bridge. Session/profile request and event APIs exist. Complete live-transcript interoperability remains untested.

Source references under the Hermes checkout:
website/docs/developer-guide/desktop-plugin-sdk.md,
website/docs/developer-guide/plugins/index.md,
apps/desktop/src/contrib/plugin.ts and plugins.ts,
apps/desktop/src/sdk/index.ts,
hermes_cli/plugins.py,
tools/registry.py,
tools/mcp_tool_transport.py,
tools/mcp_tool_scope.py,
tools/mcp_tool_registration.py, and tools/mcp_schema_cache.py.

No new feature code or runtime interoperability tests have been run. Recheck build identity at implementation and rollout.

The optional native-card idea stays deferred as a scope decision. Current Hermes Kanban behavior, re-read at 59004a6235 on 2026-09-26, is recorded here so that a later reader cannot re-derive a wrong constraint from it:

- Card creation is idempotent when given an `idempotency_key`: `create_task` returns the existing non-archived task with that key instead of creating a duplicate (hermes_cli/kanban_db.py, `create_task`), so a projection retry cannot fork cards.
- An unassigned card is not spawned by default. The dispatcher's ready lane puts a ready row with no assignee into `skipped_unassigned`; it auto-assigns and spawns only when the operator has configured `kanban.default_assignee` (default `""`), and it then persists that assignment and reports the row under `auto_assigned_default` (hermes_cli/kanban_db_dispatch.py, ready lane and `_apply_default_assignee`). The review lane never auto-assigns: an unassigned review row is always `skipped_unassigned`.
- Spawning additionally requires the assignee to name a spawnable Hermes profile. A non-profile assignee (the code's own case: a control-plane lane that pulls work itself via `claim_task`, which would otherwise loop ready→crash→ready) and an assignee excluded by the per-home claim allowlist `kanban.dispatch_profiles` both land in `skipped_nonspawnable` — bucketed apart from `skipped_unassigned` because the operator cannot fix it by assigning a profile, and suppressed from stuck-health telemetry.
- Card statuses are `triage, todo, scheduled, ready, running, blocked, review, done, archived` (kanban_db.py, `VALID_STATUSES`). A card is born `ready` unless a parent is unfinished, `triage` when requested, or parked `blocked` for human ops.
- Only the `ready` and `review` lanes are dispatched, and nothing promotes `triage`, so `triage` is the one status the dispatcher never claims: the claim path is restricted to `running`/`ready`/`review`, and no dispatcher tick decomposes it. `triage` is nevertheless not inert — it is the queue an explicit human or agent command sweeps (`hermes kanban specify|decompose [--all]`), which lists every `triage` row, rewrites the root and creates child cards routed to `default_assignee` when no installed profile fits. So `triage` is parking against automatic dispatch, not against an operator-initiated sweep. `blocked` is not a parking state: every tick runs `recompute_ready`, which promotes `todo` and non-sticky `blocked` rows to their resume status — normally `ready` — as soon as every parent is `done`/`archived`. The exceptions are a worker-initiated block (`kanban_block`) and a failure-breaker trip stamped `sticky`; those wait for `kanban_unblock` (kanban_db.py, `recompute_ready` and `_has_sticky_block`).
- Creating a card fires no creation hook today; the dispatcher fires `kanban_task_claimed` immediately before a spawn, and the completion/block hooks fire in the worker.

The residual concern for this plan is therefore narrow and configuration-dependent, not idempotency: an operator who has set `kanban.default_assignee`, or who dispatches with `kanban.dispatch_profiles` naming a worker home, would get work spawned from cards that a projection created. That is why a projection still needs an explicit decision — unassigned cards, or the `triage` status the dispatcher never claims — and why this release keeps the Monitor read-only over the Waystation ledger instead.

## 4. Common context and public interfaces

### 4.1 Three independent contexts

Every reconciliation invocation distinguishes:

1. Destination ledger: resolved by existing explicit --root, WAYSTATION_ROOT, then discovery rules.
2. Caller/worker directory: captured at CLI entry, direct MCP startup, or supplied by a validated adapter binding.
3. Evidence repository: explicit --repo resolved against the caller, otherwise the caller's Git repository.

Neither an evidence path nor Monitor selection changes the ledger. Never scan registered projects to guess a destination or source. A non-Git ledger is valid when a Git evidence source is explicitly available.

Use one immutable InvocationContext in core-facing wrappers. It contains canonical ledger location, caller directory/worktree when available, and optional adapter binding identity. Resolve source paths through W02. Do not mutate process.cwd or process-global environment for an individual call.

### 4.2 Reconciliation interface

~~~text
waystation [--root <ledger-root>] git reconcile
  --commit <hash> --agent <actor>
  [--repo <local-path>] [--task <task-id>] [--close] [--json]

MCP: reconcile_git_commit
  commit: string
  agent: string
  repo?: string
  task?: string
  close?: boolean
  worker_context?: WorkerContext
~~~

The actor is required and nonempty. It identifies the invoking Waystation actor, not the Git author. It is not an authentication credential.

The CLI already accepts claim Git context (`task claim --branch/--worktree`, consumed with a caller override inside the claim path), so the gap is narrow: only the MCP surface lacks per-call forwarding. Extend that existing contract for the adapter's bound caller worktree instead of adding a parallel one.

MCP retains its fixed ledger root. In adapter mode, validate the additional request context before mutation:

~~~ts
interface WorkerContext {
  binding_id: string;
  binding_generation: number;
  expected_ledger_root: string;
  caller_worktree: string; // absolute local path
}
~~~

W06 owns this schema and forwarding. The server verifies the expected ledger matches its fixed root and resolves a request-local caller context. The binding generation is correlation data at the server; the plugin owns generation validity. No core access to the plugin store is introduced.

A launch option for adapter-configured servers requires this context for worker mutations and Git-context-dependent reads. Direct MCP clients retain existing startup defaults. This opt-in routing check does not change legacy task lifecycle semantics.

### 4.3 Shared tool contracts

W06 maintains one allowlisted contract catalog for worker tools and generates/exports the schemas consumed by the plugin. The worker adapter does not maintain handwritten copies of every core schema. The catalog identifies caller-identity fields such as agent, actor, and from_agent for each operation; the adapter binds those fields while preserving explicit recipients, successors, task IDs, and evidence-source inputs. Generated wrapper schemas omit injected caller/context fields from model-editable inputs.

Default managed worker tools cover:

- Status, next/ready task selection, task/brief/context reads.
- Claim and release.
- Reconciliation for verified attachment/completion.
- Inbox, messages, issues, and handoffs through existing operations.
- Explicit claim transfer for a user/coordinator workflow.

Legacy finish/status tools remain available on existing surfaces, but are not the managed worker's default completion route. Do not override Hermes built-ins or register duplicate raw/wrapped worker tools in the selected toolset.

## 5. Git verification and task intent

### 5.1 Portable local Git inspection

W02 supplies one portable process adapter usable from Bun and the supported Node fallback. Use argument arrays, bounded execution/output, structured errors, and no shell interpolation. The Node fallback is real but partial today — the index layer falls back to `node:sqlite`, while the Git helper calls `Bun.spawnSync` unconditionally and the dashboard/serve path is Bun-only — so Node parity is required for CLI core and this adapter, not for the dashboard, and it is what the existing Git context helper cannot provide today (it also returns only an abbreviated HEAD).

Accept 7-64 hexadecimal input characters, then resolve against the selected repository's actual object format. Uppercase input is accepted and canonicalized only in the new verified result. Reject symbolic refs, HEAD, branch/tag names, ranges, revision syntax, ambiguous abbreviations, and non-commit objects. Do not peel an annotated tag object.

Resolve once to a full object ID and read that exact object. Merge commits, root commits, detached HEAD, and commits not reachable from current HEAD are valid. A bare repository can supply evidence; report no source worktree when absent. Worker execution bindings still require a real local worker directory/worktree.

Prevent Git replacement refs from changing the content attributed to an object ID. Disable lazy network object fetching and interactive prompts; a missing promised object is unavailable locally, not permission to fetch. Do not run hooks or write into the evidence repository.

Read object format, full ID, raw commit message, parent IDs/count, and source checkout context. Branch/HEAD are observational metadata; moving HEAD does not change the immutable commit under reconciliation. Decode the message explicitly and preserve original bytes/encoding metadata if lossless decoding is unavailable. Parser line-ending normalization must not alter stored descriptions.

Output limits must produce a clear diagnostic rather than silently truncating a commit message or calling a partial object verified.

### 5.2 Repository identity

Source identity is local provenance: derive a deterministic ID from the canonical Git common-directory filesystem location. Resolve aliases using platform-aware canonicalization; do not indiscriminately lowercase case-sensitive directories.

Linked worktrees of one repository share a source ID. Separate clones are separate sources even when remotes match. Remote URLs are not identity and are not persisted as credentials-bearing identifiers.

Moving a checkout changes its location-based source identity. Historical associations remain intact; new verification at the new location is recorded separately. Portable repository rebinding is outside this release.

Two identities are used deliberately:

- Evidence association: source ID + object format + full object ID.
- Commit identity for the reopened-work guard: object format + full object ID, independent of source.

Copying a prior completion commit into another repository cannot make it eligible to close reopened work.

### 5.3 Tolerant, deterministic trailer grammar

Parse the chosen commit's message, never a parent message or the current HEAD message.

1. Ignore trailing blank lines.
2. A subject alone is never a trailer block.
3. Locate the final paragraph after a blank separator. It is a trailer-block candidate when it starts with a trailer-shaped key/value line, or a recognizable malformed Waystation directive. A final ordinary prose paragraph is not reinterpreted as trailers.
4. Within a candidate, parse trailer lines and valid continuations for unrelated trailers. A malformed candidate containing a Waystation directive is an error, not a reason to fall back to explicit task selection.
5. Match Waystation keys with ASCII case-insensitivity. Task ID values remain exact, case-sensitive RecordIds.
6. Require exactly one Waystation-Task if present. Duplicate keys fail even with matching values or different key capitalization.
7. Reject empty/invalid task IDs, Waystation directive continuation, unknown Waystation-* keys, and Waystation-Close inside the block.
8. Ignore marker-shaped lines outside the final block, including body examples. They do not select a task, conflict with a final marker, or request closure.
9. Permit unrelated trailers such as Signed-off-by. Behavior must not depend on user Git trailer configuration.

~~~text
fix: retain imported formatting

Details of the change.

waystation-task: task-formatting
Signed-off-by: Example Author <author@example.invalid>
~~~

When a valid task trailer exists, it selects the task. An explicit task argument is allowed when no task trailer exists; if both exist they must match. Explicit task selection never bypasses invalid final-block directives.

The command's close flag is the only close instruction. A marker-looking line in a final trailer block is not treated as an ignored body example merely because it was intended as documentation.

## 6. Evidence schema and legacy compatibility

Keep TaskRecord.commits as an ordered string array. Do not migrate it to objects or remove historical references. Add the optional, versioned TaskRecord.commit_evidence field owned by W04; absence remains valid and is not automatically materialized during unrelated reads.

The implementation should use this logical shape, finalized as Zod schemas in src/core/schema.ts:

~~~ts
interface CommitEvidence {
  schema_version: 1;
  entries: Array<{
    source_id: string;
    source_common_dir: string;
    object_format: "sha1" | "sha256";
    oid: string;
    aliases: string[];          // original refs verified to mean this object
    message: string;            // original decoded full message, no parser normalization
    encoding?: string;
    raw_message_base64?: string; // only where needed for lossless retention
    observed_at: string;
    observed_by: string;
    source_worktree: string | null;
  }>;
}
~~~

Subjects/body are derived for display; task.description is not replaced. Lifecycle/closure links remain in canonical events; the metadata is not a second lifecycle ledger.

Rules:

- New verified evidence records full ID, source association, original message, and observation context in the same mutation.
- Append the full ID to commits only if no already-established reference represents that object. An existing verified short alias is retained rather than rewritten for normalization alone.
- The same object from a new source is a new association, even if commits already contains the hash. Do not duplicate an identical string just to represent another source.
- Never infer original historical source from finding an object in the currently chosen repository. A new association means verified here now.
- Unresolved unrelated legacy strings and their stored descriptions remain unchanged and yield warnings.
- If a historical string could alias the requested object and identity cannot be established, refuse the requested mutation. Prefix compatibility identifies candidates; it is not proof.
- During a real attachment/closure, missing descriptions for old references with established sources may be recovered locally and included in the same intent.
- An otherwise satisfied no-change request never becomes a hidden metadata backfill.
- Same source/object with conflicting stored immutable message data is an integrity error, not an overwrite.
- Unknown fields on task records and raw claim records must survive writes. TaskRecord already round-trips them; ClaimRecord does not, and every claim is loaded through its schema, so a claim mutation drops unknown keys today. W01 owns the preservation behavior in the shared record path; the one-line schema change lands as W04's early additive-schema edit, before the transfer intent writes a claim it does not own.

Persisted descriptions remain visible offline. Missing legacy descriptions are labeled unavailable. A general backfill command is deferred.

## 7. Reconciliation algorithm and guarantees

### 7.1 Preconditions

Validate inputs, context, local object identity, and task intent before new mutation planning. Under the canonical ledger lock, recover any previous intent and reload current tasks, claims, and relevant history.

Reject:

- Duplicate target task IDs or ambiguous source filenames.
- Invalid schemas or duplicate claim IDs affecting the target.
- Multiple active claims for the target.
- Divergent target lifecycle state.
- Unsafe record paths or conflicting evidence metadata.

For reconciliation, consistent in_progress means exactly one active claim; other states have none. Terminal tasks have a valid closed_at; open tasks do not. Completed/released/stale historical claims remain history. Existing inconsistent records require repair rather than silent normalization.

Resolve immutable Git data outside the lock where possible. If historical resolution depends on ledger state, capture a ledger revision, resolve bounded Git reads, reacquire, and verify that revision before committing; retry a bounded number of times or return contention. Do not perform an unbounded subprocess while holding the ledger lock.

### 7.2 State table

All entries apply after validation and source-qualified evidence comparison.

| Current task and request | Outcome |
| --- | --- |
| Consistent open task, attach-only, new evidence association | Attach and update updated_at; preserve status/claims. |
| Consistent open task, attach-only, same verified association | Successful no_change. |
| in_progress, close, one active claim owned by actor, eligible evidence | Attach if needed, complete claim, close task in one recoverable intent. |
| Open task in any other state, close | Refuse; attach nothing. |
| in_progress owned by another actor, close | Owner mismatch; attach nothing. |
| done, same verified association, attach-only or close | Successful no_change, regardless of retry actor. |
| done, new evidence association, attach-only | Attach; update updated_at; preserve closed_at and completed-claim timestamps. |
| done, new evidence association, close | Refuse; caller must deliberately retry attach-only. |
| wont_do, any request | Refuse, including repeated evidence. |
| Inconsistent target, invalid object/intent, or unresolved relevant ambiguity | Refuse new mutation. |

For a first closure, evidence may already have been attached to the open task. For reopened work, an object used to close an earlier lifecycle is ineligible even if currently attached under another source.

Reconstruct earlier completion evidence from canonical lifecycle/reconciliation events in append order, not timestamp sorting alone. Reopen events and historical completed claims are signals of an earlier lifecycle. If prior completion is indicated but earlier history cannot establish a reliable boundary, use the conservative fallback: require an object not already represented in the reopened task's existing evidence and disclose the fallback in diagnostics. An unresolved potentially matching historical ref blocks this check. Deleting all lifecycle history by hand makes prior completion unknowable; this operation cannot reconstruct erased facts.

“New evidence” is an identity rule, not proof that a commit contains sufficient new work, passed tests, or was authored after a particular date. Acceptance verification remains the worker/reviewer responsibility.

### 7.3 Mutation and timestamps

A close request is all-or-nothing with respect to the new intent. Failed closure does not partially attach evidence. A real closure updates task status/updated_at/closed_at and the active claim's status/completed_at.

No-change means no new task/claim writes, metadata backfill, timestamp changes, or events. It may still follow recovery of a prior interrupted mutation. The original commit must still be locally verifiable; an offline stored description alone does not satisfy a new verification request.

Use the actual loaded filenames. Do not create a second task or claim file based on an assumed name.

### 7.4 Result

All surfaces return CommandResult with data, errors, and warnings. The reconciliation data contract includes:

~~~ts
interface ReconcileGitCommitData {
  task: string;
  requested_commit: string;
  commit: string;
  repository: {
    id: string;
    object_format: "sha1" | "sha256";
    common_dir: string;
    source_worktree: string | null;
  };
  caller_worktree: string | null;
  action: "attached" | "closed" | "no_change";
  commit_attached: boolean;
  task_closed: boolean;
  status_before: TaskStatus;
  status: TaskStatus;
  task_source: "trailer" | "explicit";
  git: {
    branch: string | null;
    head: string | null;
    detached: boolean;
    parent_count: number;
    merge: boolean;
  };
}
~~~

commit_attached means a new source/object association, not necessarily a new string in commits. Human output distinguishes attachment, closure with attachment, closure using existing evidence, and no change.

CLI failures return nonzero status and valid JSON envelopes when JSON is requested, including argument errors. MCP uses equivalent envelopes. No raw stacks or transport-specific task_source values.

### 7.5 Audit events

For one real reconciliation mutation, append in deterministic order:

1. task.commits_attached when a new evidence association was recorded.
2. task.status_changed when closure occurred.
3. claim.completed when closure occurred.
4. task.git_reconciled describing the complete outcome.

Include actor, task, active claim when applicable, full object/source identity, supplied hash, task source, explicit close input, outcome booleans, caller/source context, and captured metadata identities. Existing event consumers must tolerate additive fields. No second audit store.

## 8. Explicit claim transfer

Transfer is a separate core lifecycle operation, not a reconciliation override.

~~~text
waystation task transfer <task-id>
  --agent <requesting-actor>
  --expected-claim <old-claim-id>
  --to-agent <successor>
  --worktree <successor-worktree>
  --reason <reason>
  --request-id <stable-operation-id>
  --previous-worker-stopped
  [--handoff <handoff-id>] [--json]

MCP: transfer_task_claim
  task, agent, expected_claim, to_agent, worktree, reason,
  request_id, previous_worker_stopped: true, handoff?
~~~

A user or coordinating agent invokes it under the project's trusted-local authority model. Actor text and a stopped acknowledgement are audit inputs, not authentication or proof of OS process termination. This release adds no role/ACL subsystem.

Procedure:

1. Stop the previous worker through Hermes/user coordination and inspect preserved work.
2. Create a handoff under the coordinator's real identity if appropriate; do not fabricate messages from the unavailable worker.
3. Submit transfer with a stable request ID and expected current claim.
4. Under one lock, recover pending work, validate the target, and check for a prior exact transfer receipt.
5. For a new request, require consistent in_progress, exactly the expected active claim, a different successor identity, valid successor context, reason, and stopped acknowledgement.
6. Release the old claim and create one active successor claim in a single intent. Keep task in_progress, retain evidence, update task.updated_at, and preserve old claim/history.
7. Append claim.released, task.claimed for the successor, and task.claim_transferred with the exact request identity and inputs.
8. Successor confirms ownership, reads the handoff, then resumes. It closes later through ordinary reconciliation.

Retry contract:

- The same request ID and exact inputs find the durable receipt and return no_change with original old/new claim IDs.
- Report current ownership separately; a retry must not imply the original successor is still active after later lifecycle changes.
- Reusing an ID with different inputs is a conflict.
- An unseen request with a stale expected claim is refused.
- Recovery never creates a second successor claim.

The operation does not attach commits, close tasks, kill processes, launch workers, expire claims, or interpret disconnects as release. The managed adapter checks ownership before work/resume boundaries; it cannot block arbitrary filesystem writes by an old external process.

## 9. Persistence and recovery

### 9.1 One lock implementation

W01 owns a single acquisition/release primitive in store.ts with two policies:

| Policy | Behavior |
| --- | --- |
| Mutation | Preserve existing cleanup/recovery behavior, then execute the new operation. |
| Read-only snapshot/detail | Acquire the same lock; do not recover, sweep, create ledgers, or modify canonical/derived data. Refuse a pending intent. |

Normalize ledger aliases consistently for every cooperating reader/writer so junctions/symlinks do not create independent locks for one ledger. Preserve user-facing paths separately where useful. Release locks in finally and use existing coded contention behavior.

Transient lock bookkeeping is permitted on the read path. No Git subprocess, network request, Hermes call, or response rendering runs under a snapshot lock.

The current acquisition primitive cannot serve the read policy as written: it creates the ledger directory before locking and sweeps orphaned temp files once per process on first acquisition. W01 therefore splits acquisition into a mutation path (create, sweep, recover, then run) and a read path (lock only), and leaves the missing-ledger failure where it already lives, in ledger resolution. `withLedgerLock` keeps its present behavior for every existing caller.

### 9.2 Version-2 mutation intents

Replace the batch-level “any event exists” check with stable event identity:

- A unique mutation ID plus an ordinal/event ID for every expected event.
- Validated intent version/kind, safe record targets, complete record payloads, and expected ordered events.
- Complete preflight validation of intent paths, payloads, and existing event prefix before applying additional recovery writes.
- Canonical target containment checks, including symlink/junction escapes; never trust a string prefix alone.
- Atomic per-file replacement with existing fsync guarantees.
- Append only the exact missing suffix of the event sequence.
- Verify payload equality for any already-present event identity.
- Remove the intent only after expected records/events are durably complete.

Duplicate, reordered, conflicting, unknown-extra, or torn/invalid relevant event data is a recovery error. Preserve the pending intent and evidence for repair. Do not trim a corrupt tail silently or rewrite history to fit an expectation.

### 9.3 Version-1 compatibility

Recover legacy intents only when existing events for the mutation match an exact expected prefix in order and count. Repeated identical payloads are compared by position, not set membership. Append the missing suffix and preserve historical formatting/records.

Malformed event logs that prevent trustworthy recovery cause refusal. Do not interpret ignored JSON parse failures as proof of an empty log.

All current intent producers adopt W01's version-2 constructor; feature packages do not independently refactor persistence. Existing behavior tests must continue to pass apart from the intentional recovery correction.

### 9.4 Limits and upgrade

This provides crash-recoverable consistency for cooperating writers/readers, not database isolation for every process that opens JSON files. Manual writes bypassing locks are outside that guarantee.

Old binaries reject unknown intent versions but may write old-format operations when no intent is pending. Therefore coordinate writer upgrades; do not claim mixed old/new concurrent writers are supported. Before rollback, settle new-format pending intents using the compatible build and preserve additive metadata. A failed recovery is a diagnostic/repair situation, not automatic ledger regeneration.

## 10. Generic snapshot and bounded reads

W05 owns the read model; W06 exposes it. Neither Hermes adapter reimplements task readiness, dependency rules, or lifecycle truth.

### 10.1 Interfaces

~~~text
waystation snapshot --json [--if-revision <revision>]
waystation snapshot detail --kind <task|issue|handoff> --id <id> --json
waystation snapshot thread --thread <id> [--cursor <cursor>] [--limit <n>] --json
waystation snapshot history --task <id> [--cursor <cursor>] [--limit <n>] --json

MCP:
  get_ledger_snapshot
  get_ledger_record_detail
  get_ledger_thread_page
  get_ledger_task_history
~~~

Reuse existing read helpers where they satisfy the new consistency contract. Do not create parallel message-loading/readiness implementations. Large detail bodies, including commit messages, use bounded/chunked detail responses under the same read API rather than silent truncation.

### 10.2 Snapshot contract

Versioned data includes:

- Explicit selected ledger root/label and schema version.
- Snapshot time and content revision.
- Complete task summaries with all seven statuses, priority, scope, dependency IDs, readiness/blockers, and evidence summaries.
- Active claims, their task/actor/worktree/branch, and relevant consistency diagnostics.
- Counts for tasks, issues, messages, and handoffs.
- Bounded issue/handoff/recent-message summaries with total counts and explicit completeness metadata.
- Commit subjects/provenance/history summaries where stored, excluding large bodies.

Reuse taskReadiness/isActionable. todo is never silently promoted to ready. Snapshot counts must match the full selected project rather than only visible/paginated rows.

Use a deterministic content hash over the relevant canonical read set, including stable relative filenames and bytes. Include config/scopes used by the view and events needed for history. Exclude generated_at, lock artifacts, index files, reports, and display selection. Timestamp-only revisions are insufficient.

If the caller supplies an unchanged revision, return an explicit unchanged result with a fresh observation time. Do not return an empty task list that a client could mistake for deletion.

Define a configured maximum response size. If a complete task summary exceeds it, return a size diagnostic; never mark a truncated board complete. Large-ledger paging can be a later extension; bounded detail/thread reads are required now.

### 10.3 Pagination and consistency

- Default page size 100, maximum 200, additionally bounded by serialized response size.
- Threads order by parsed created_at then exact message ID as tie-breaker; preserve reply IDs without assuming the parent is on the same page.
- Event history uses canonical append order and a stable event offset/identity; equal timestamps do not reorder history.
- Opaque cursors encode version, ledger identity, relevant collection revision, query/order, and last key.
- A cursor cannot be reused for another project, query, or collection.
- If relevant content changed, return cursor_stale and let the client restart/merge by stable IDs. Do not silently skip or duplicate records.
- A single over-limit body is served through explicit bounded detail chunks or fails clearly; every truncated summary links to full detail.
- Detail/history responses identify their revision so the UI can indicate a newer view than the last board snapshot.

Load/validate under the nonrecovering lock. Missing ledgers, inaccessible directories, invalid JSON, duplicate IDs, and pending mutation recovery are errors, never successful empty collections. Detect observed external edits using before/after fingerprints and refuse unstable reads. This is best-effort detection of noncooperating edits, not a proof that arbitrary manual writers participated in the lock.

Lifecycle inconsistencies in otherwise readable records must be visible as integrity diagnostics and must not be interpreted as actionable work. A structurally unreliable board fails with last-good data retained by the UI; reconciliation separately validates its own target.

## 11. Hermes package and project registry

### 11.1 One package

~~~text
integrations/hermes/
  plugin.yaml
  __init__.py                 # assembly/registration entrypoint
  contracts/                 # generated/shared Waystation tool contracts
  registry/                  # authoritative project configuration
  worker/                    # session binding and native-MCP forwarding
  dashboard/
    manifest.json
    plugin_api.py            # read-only Waystation data endpoints
  desktop/
    plugin.js                # built native plugin artifact
    src/                     # native Monitor source
  tests/
  README.md
~~~

This is a packaging design; these files do not exist as an implemented feature yet. W08 owns shared manifests/assembly and registry. W07 owns worker modules and supplies one registration entrypoint. W06 owns the source tool contracts. Runtime artifacts are built/copied during the documented install procedure, not by forking Hermes core.

Native UI and backend enablement are checked separately. Plugin disablement leaves the canonical ledger untouched and does not release claims. It may make the adapter unavailable; the UI must report that accurately.

### 11.2 Registry contract

One versioned, backend-readable plugin configuration store holds registrations. Name the Hermes mechanism instead of inventing storage: the plugin already has a profile-scoped durable JSON state facade (`ctx.state`, hermes_cli/plugins.py) for exactly this kind of operational state, and separately a settings subtree in config.yaml reachable through `ctx.get_config`/`set_config` (`plugins.entries.<plugin_id>.settings`) for operator-edited values. Registrations and bindings are operational state written by the plugin, so they belong in plugin state; the config.yaml settings path stays for the operator-granted allowlist. Note the coupling cost before choosing: project MCP entries live in `mcp_servers`, and a Hermes MCP config change rebuilds the tool surface and invalidates the provider prompt cache, so registration churn is a rollout-policy decision (batch it, and state whether a restart or `/reload-mcp` is needed).

~~~ts
interface ProjectRegistration {
  key: string;                // generated stable local identity
  label: string;
  ledger_root: string;        // canonical destination
  mcp_server: string;         // profile's explicit project-bound entry
  revision: number;
  state: "active" | "retired";
}
~~~

Do not use Waystation config.project_id, a folder name, or remote URL as a globally unique key. Detect duplicate filesystem aliases. Registry configuration is local operational state, outside .waystation.

A configured fixed registry location is shared by worker and Monitor adapters on this native machine. Scope access to the selected local Hermes runtime/profile route; no silent “current profile” substitution. Browser storage may hold UI preferences, never a competing authoritative project list.

Registration settings may select a local root; normal data endpoints accept only a registration key and record identifiers, not arbitrary paths or command names. Use atomic local config writes and a short plugin-config lock. Never hold it while waiting on a Waystation ledger lock or MCP request.

Project selection only changes the view. Root/server reassignment for an existing registration is refused while bindings/calls reference it; create a new registration or drain it first.

Retirement/removal semantics:

1. Hide the project from ordinary Monitor selection and prohibit new bindings.
2. Retain the registration identity and immutable routing for existing bindings, including restart.
3. Existing workers continue on their pinned route; removal does not delete their ledger or kill them.
4. Hard-delete only after no bindings/in-flight calls reference it.
5. A genuinely missing/corrupt root or invalid route still causes an explicit worker error; never redirect it elsewhere.

## 12. Shared-profile worker adapter

### 12.1 Binding

The plugin exposes an explicit binding command in the worker/coordinator context. Inputs are a registered project key, worker worktree, and stable Waystation actor. The Monitor has no worker-control buttons.

A binding stores:

- Binding ID and generation.
- Local runtime/source and profile/home identity.
- Host-supplied durable session/lineage identity where verified.
- Actual delegated-worker/execution identity when needed.
- Registration key/revision and pinned route/root.
- Absolute canonical caller worktree and actor.
- Creation/update metadata and active/retired state.

Binding metadata is not task ownership. A successful claim in Waystation is still required before code work.

The adapter must not infer session identity from model text, task titles, agent names, or the active UI tab. Hermes task_id is not a Waystation task ID. Separate delegated workers require distinct bindings whenever their execution context differs. If the host cannot distinguish them reliably, refuse binding/dispatch with an actionable diagnostic.

Within one project, distinct active worker bindings cannot share a Waystation actor accidentally. A verified resume of the same worker may reuse its actor. Identical actor/task names in different projects are valid.

### 12.2 Routing

Configure one MCP entry per destination project, with the ledger encoded in command arguments. Use Hermes's existing client through ctx.call_mcp; no private parallel client or general shell proxy.

For every supported worker call:

1. Obtain host-provided session/worker/profile context.
2. Resolve and validate exactly one binding.
3. Validate registration/pinned route, worktree, binding generation, and required ownership context.
4. Resolve the operation from the generated allowlisted tool catalog.
5. Supply bound actor and WorkerContext; ignore/reject model attempts to override those values.
6. Forward to the project-bound server through the granted native MCP route.
7. Decode transport and Waystation results separately, preserving diagnostics.
8. Release local in-flight accounting without changing the binding implicitly.

The optional reconciliation repo argument remains an explicit evidence source. It is resolved relative to the bound caller and never becomes the worker's project.

Required-context mode on adapter servers prevents accidental calls that omit context. It does not authenticate a claimed actor or make raw tool access an OS security boundary. Configure the managed agent toolset to avoid duplicate raw mutation routes.

### 12.3 Lifecycle, resume, and rebind

- Capture an immutable binding/generation per call.
- Changes of project/worktree/actor require an explicit rebind and no in-flight calls or active claims tied to the old binding.
- Reattaching a verified same worker/session to an unchanged durable binding after restart is resume, not a project-changing rebind.
- Revalidate existing claims/worktree before resuming edits.
- Session compression/rotation follows only a verified host lineage. Missing lineage requires an explicit coordinator-assisted association to the unchanged binding; changing owner still requires release/transfer.
- A replacement worker binds as itself and receives ownership only through the approved claim/transfer lifecycle.
- Disconnect, timeout, application exit, and lost heartbeat do not close/release tasks.
- Never mutate global cwd/environment or a shared MCP server's root during a request.
- A retired project preserves pinned existing bindings as defined above.

Stable actor binding is operational consistency, not an authentication system.

### 12.4 Outcomes and payload limits

Validate the inner CommandResult; Hermes outer ok is not enough. A truncated response may follow a successful write, so report an unknown outcome rather than claiming nothing happened.

Preserve whether failure was before dispatch or after a call might have reached the server. Never automatically replay claim/message/handoff mutations merely because output was lost. Inspect state and follow the operation-specific retry contract. Reconciliation and transfer have the explicit contracts above.

Read responses must fit below the native client cap after envelope overhead. The cap being fitted is Hermes's 65,536-**character** limit on the serialized envelope-inclusive string, applied with a truncation marker and a `truncated` flag, so `ok: true` reflects only the transport envelope. Target at most 48 KiB serialized payloads for plugin worker reads, with pagination/chunking; do not assume a byte limit equals a character limit, and treat a truncated response as an unknown outcome for any write it may have carried. Do not truncate canonical message bodies to fit a wrapper.

The adapter does not inspect a result string for prose such as “success.” It validates shape and types.

### 12.5 Feasibility gates

Before enabling worker execution against real projects, fixtures must prove:

- Host identity is supplied correctly for normal and delegated workers.
- Parallel sessions in one profile remain separate.
- The native client dispatches the selected project server in the correct profile scope.
- Per-call worker context reaches the correct core invocation.
- Resumes/reconnects do not reuse another binding.
- Disabled plugins, absent allowlists, and unavailable context produce refusal.
- Runtime plugin registration and packaged desktop/backend targets interoperate.

Use documented plugin APIs; isolate any necessary compatibility shim. Failure does not permit silently falling back to startup cwd, one profile per worker, or a Hermes core modification. Record the blocker for a separate design decision if the chosen mechanism cannot pass.

## 13. Native Monitor and discussions

### 13.1 Required views

- Project selector and explicit selected-project identity.
- Tasks grouped by all seven original statuses, with priority, readiness, and dependency blockers.
- Task detail with description, acceptance, claims, evidence sources/messages, and lifecycle history.
- Active claim view with actor, branch/worktree, and recorded claim times.
- Issue list/details.
- Handoff list/details with unfinished work, tests, risks, and next steps.
- Agent discussion threads over existing Waystation messages.
- Last successful observation, stale/error state, and manual refresh.

Display wont_do distinctly from done. Claims are not Hermes assignments or worker runs. Do not convert arbitrary dependency graphs into parent/child relations. A wont_do dependency is satisfied, not blocking: readiness treats `done` and `wont_do` alike, so a wont_do blocker must render as satisfied (with its terminal status visible) rather than as an unmet dependency.

Agent chat means the canonical messages already posted through Waystation: sender, recipient/broadcast, kind, timestamp, thread, reply link, and associated task/issue. It is not an import of every conversation elsewhere. No reply composer, dispatch, status drag, close, transfer, or assignment action is included.

### 13.2 Read adapter

Use the plugin's namespaced REST backend and the Waystation snapshot/detail CLI as the initial Monitor transport. Fix this choice; do not implement both CLI and MCP Monitor transports.

The Python adapter accepts registration keys, invokes only allowlisted read commands via argument arrays, supplies the explicit root, enforces timeout/output bounds, validates CommandResult, and returns data. No direct canonical file parser, arbitrary command proxy, sync, repair, or task mutation.

Keep registry settings separate from data endpoints. A user-configured path may enter through registration; a task/thread request may not substitute its own path.

### 13.3 Refresh and rendering

- Poll at five-second intervals only while the page and desktop window are visible.
- One request per selected project/view at a time; coalesce manual refresh with in-flight work.
- On failure, back off to 10, 20, 40, then 60 seconds; reset after success.
- Cancel/ignore work on hide, project/profile switch, unload, or disable.
- Capture registration revision and display generation; discard late results for earlier selections.
- Retain last-good data visibly stale; never replace it with zeros on error.
- Distinguish an actually empty project from a failed read.
- Scope caches, links, cursors, filters, and errors by project and relevant runtime/profile route.
- Use content revision to avoid unnecessary rerenders; timestamp changes alone do not change task data.
- Escape commit messages and agent content as untrusted text. Do not execute instructions rendered from records.

No app automation or background monitor job is created. Existing in-process Waystation dashboard events are not a cross-process delivery guarantee.

### 13.4 Optional live Hermes sessions

After the canonical discussion view passes acceptance, assess the pinned host's transcript/activity APIs. Reuse verified binding/session associations from W07 rather than inventing a second mapping.

If feasible, provide an explicitly Hermes-sourced read-only view with durable/live identity handling, pagination, profile routing, and refresh tests. Do not copy transcripts into the ledger, guess associations by actor name, send prompts, control workers, or block baseline delivery while this is assessed.

## 14. Diagnostics and observability

Use src/core/result.ts as the single core diagnostic catalog. Every added code has severity, message, hint, and class-level retryability. Reuse existing codes by name where their meaning already matches, so no surface invents a synonym: `multiple_active_claims`, `claim_status_divergence`, `duplicate_id`, `invalid_commit_ref`, `no_git_claim_match`, `ambiguous_git_claim`, `no_active_claim`, `claim_owner_mismatch`, `task_done`, `invalid_transition`, `no_such_task`, `lock_contended`, `mutation_intent_invalid`, `ledger_not_found`, `git_not_repository`, `git_command_failed`, `unexpected_error`.

New diagnostic families must cover:

| Family | Required distinctions |
| --- | --- |
| Git input/source | Invalid hash, unavailable/ambiguous object, wrong object type, missing Git, invalid repository, output/timeout failure, unavailable local promised object |
| Intent | Missing task selection, conflicting sources, invalid/duplicate/unsupported trailer |
| Evidence | Unresolved unrelated legacy ref warning, relevant identity ambiguity, immutable metadata conflict, earlier completion evidence |
| Ledger | Target integrity divergence, invalid recovery intent, conflicting event replay, pending recovery on read |
| Transfer | Stale expected claim, reused request ID with different inputs, missing stopped acknowledgement |
| Read model | Inaccessible/missing ledger, stale cursor, unstable read, oversized response |
| Adapter | Missing/ambiguous binding, invalid generation/context, wrong root/profile route, missing capability/grant, transport outcome unknown |

Core-origin errors remain core diagnostics. Plugin-specific routing errors use a namespaced, stable adapter catalog; do not copy business validation into Python. Map errors to clear remediation without raw stacks, credentials, or full environment dumps.

Logs include bounded operation/request identity, binding/project correlation, duration, and outcome. They are operational logs, not another task history database.

## 15. Implementation ownership and dependency plan

One package owns each implementation concern. The future Waystation task graph must use these slices rather than creating duplicate “Git” and “Hermes” versions of shared work.

| Package | Sole deliverable | Prerequisites | Primary ownership |
| --- | --- | --- | --- |
| W00 | Freeze contracts, pins, schema names, diagnostics, and task split from this plan | Final plan review | This plan/ADR and contract checklist |
| W01 | Canonical lock policies, read/mutation acquisition split, intent v2/v1 recovery, record-path and unknown-field preservation helpers, ledger fault fixtures | W00 | store.ts and shared persistence tests |
| W02 | Portable Git inspection, source identity, context/path helpers, Git fixtures | W00 | Git/context core modules |
| W03 | Deterministic tolerant trailer parser | W00 | Parser module and grammar fixtures |
| W04 | Evidence schema, reconciliation, old-ref rules, lifecycle guard, explicit transfer | W01-W03 for reconciliation; W01/W02 for transfer | Core mutation/schema modules and unit tests |
| W05 | Snapshot, bounded detail/thread/history model, revision/cursor semantics | W01; metadata contract frozen in W00 | Read-model core and tests |
| W06 | CLI/MCP surfaces, per-call context validation, exported tool contracts | Context slice: W02; reconciliation/transfer: W04; reads: W05 | CLI/MCP entrypoints and surface tests |
| W07 | Shared-profile worker adapter, binding store, native-client forwarding, worker setup and fixture gates | W06 context/contracts/worker operations; W08 foundation | integrations/hermes/worker/ and worker tests |
| W08 | Registry/package foundation; Monitor backend/native UI/discussions; final assembly; optional live-session assessment | Foundation: W00; Monitor: W06 read surfaces; assembly: W07 and Monitor | Registry, manifests, desktop/, Monitor backend/tests |
| W09 | Cross-component, cross-process, installed-Hermes and compiled acceptance | Relevant W01-W08 slices | Integration fixtures and evidence |
| W10 | Documentation, version/build, package validation, selected deployment and rollback | W09 and required slices | Release/version authorities and rollout record |

W05 can implement against the frozen optional evidence contract without waiting for reconciliation runtime. Schema-file edits still have one owner, W04, with an early additive-schema task if needed; that early task includes ClaimRecord unknown-field preservation (§6), which W04's transfer intent depends on. W01 owns migration of all existing intent producers. W06 coordinates diagnostic declarations before feature consumers need them; no consumer duplicates the catalog.

Required dependency slices:

~~~text
W00
 ├─ W01 ─────────────── W05 ── W06 reads ────────── W08 Monitor
 ├─ W02 ── W06 context ───────────────────────┐
 ├─ W03                                     |
 └─ W08 foundation ─────────────────────────┤
W01 + W02 + W03 ── W04 ── W06 worker ops ─── W07
W07 + W08 Monitor ── W08 assembly ── W09 ── W10
~~~

The diagram omits some direct testing prerequisites for readability; the table is authoritative. W08 foundation does not depend on W07. W08 assembly does. Never create a single indivisible W08 task with a reciprocal W07 dependency.

Further overlap rules:

- W01 ledger path/lock helpers and W02 Git evidence path helpers are distinct.
- W04 alone owns claim transfer and reconciliation state changes.
- W05 alone computes snapshot/readiness; adapters only consume results.
- W06 alone registers Waystation tools and defines their contracts.
- W07 alone owns execution bindings; W08 may read their explicit association for the optional session view.
- W08 alone owns registry and package manifests; W07 contributes an entrypoint.
- W10 alone owns the coordinated version bump and final installation artifact.
- Shared-file changes are serialized or assigned one integrating owner.
- W09 adds interaction tests, not copies of every unit suite.

## 16. Acceptance and test matrix

Use isolated temporary ledgers and Git repositories. Do not mutate live project tasks or the original DuckBrain incident as test fixtures. Tests clean up only their verified fixture roots.

| Acceptance group | Owner | Required cases |
| --- | --- | --- |
| A01 Git resolution | W02 | Full/short/uppercase hashes; ambiguous/missing/non-commit objects; SHA-1 and SHA-256 where available; replacement refs; offline missing objects; no fetch/hooks; time/output bounds; Node/Bun parity. |
| A02 Context/provenance | W02 | Explicit and relative source paths; omitted source uses caller; no ledger fallback; non-Git ledger; linked/bare repos; clone distinction; moved paths; Windows aliases/spaces/case behavior; merge/root/detached commits. |
| A03 Intent | W03 | Mixed-case keys accepted; exact task IDs; explicit fallback/match/conflict; duplicate/unknown/close keys; malformed final candidate; body examples ignored; continuations; subject-only marker; CRLF/LF; unrelated trailers. |
| A04 Evidence | W04 | New association versus repeated association; old short/full equality without normalization write; unresolved unrelated warnings; relevant ambiguity refusal; metadata conflicts; offline stored descriptions; legacy unknown provenance; retention through reopen/transfer. |
| A05 Lifecycle | W04 | Every state-table row; owner and nonowner close; all-or-nothing failure; done/new-source attach-only; wont_do rejection; prior completion object cannot reclose under another source; legacy fallback. |
| A06 Idempotency | W04 | Repeat attach/close; different retry actor on done; exact transfer retry; mismatched transfer request ID; no extra timestamps/events; pending recovery distinguished from new effects. |
| A07 Transfer | W04 | Expected claim mismatch; stopped acknowledgement; one successor; old actor loses ownership; real coordinator audit identity; current ownership reported on late receipt retry; no task closure/worker launch. |
| A08 Persistence | W01 | Fault after intent, between record writes, after every event, after all events before deletion; v1 missing/partial/full/repeated prefix; corrupt/torn/reordered/extra events; target escape; alias lock identity; real separate-process contention. |
| A09 Existing behavior | W09 | Existing claim/release/finish/status/create/update and dashboard behavior preserved; unknown record fields retained; old-reader additive metadata; incompatible writer upgrade documented. |
| A10 Read model | W05 | Complete task/count/readiness summaries; pending intent untouched; no cleanup/sync; missing versus empty; revision no-change; duplicate/invalid data; cursor scope/staleness; equal-time ordering; large-body chunks; observed external changes. |
| A11 Surfaces | W06 | CLI help/JSON/exit codes, MCP parity, tool schemas; wrong root/missing required context; concurrent request-local worktrees; legacy direct defaults; human outcome distinctions. |
| A12 Shared-profile workers | W07 | Two workers/worktrees on one project connection; two projects with identical task/actor names; delegated identity; actor collision within project; explicit bind/rebind/resume; generation race; profile routing; lost claim. |
| A13 Transport | W07 | Outer success/inner failure; malformed/truncated response; unknown write outcome; operation-specific retry; unavailable grant/plugin/server; payload cap and chunking; no raw-context fallback. |
| A14 Registry | W08 | Duplicate aliases; persistent stable keys; display change versus worker routing; retirement preserving live/restarted bindings; blocked hard delete/reassignment; missing real root fails without retarget. |
| A15 Monitor | W08 | Seven statuses; task/evidence/issue/handoff/discussion detail; source fidelity; no writes/cards/runs; 5-second visible refresh; backoff; hidden/unload cleanup; stale data; late-response discard; escaped content; native SDK loading. |
| A16 End-to-end | W09 | Select/claim/work/commit/reconcile/observe; takeover/resume/close; reconnect after completed write; two-process races; one invalid project isolated; source and compiled Windows fixtures. |
| A17 Packaging | W10 | Three version authorities agree; compiled asset build; plugin backend/desktop enablement; installed target pin; rollback with settled intents; ledger untouched by uninstall. |
| A18 Optional live session | W08 | Only after baseline: verified association, profile/durable/live IDs, read-only transcript/activity, pagination and no copied canonical messages. |

Faults must occur at deterministic injection boundaries. Do not add a production crash switch. Recovery tests need at least one real separate-process fixture in addition to pure fault seams.

Tests appropriate to implementation include:

~~~powershell
$bun = "C:/bun/bin/bun.exe"
& $bun run dashboard:build   # first: the compiled-dashboard case builds the CLI and needs src/dashboard/client/dist
& $bun test
& $bun run typecheck
& $bun run check
graphify update .
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views
& $bun run build
./waystation.exe --version
./waystation.exe validate --project --views
git diff --check
~~~

Baseline recorded 2026-09-26 at 9907de9 with the dashboard client unbuilt: `bun test` gives 283 pass and 1 fail, the failure being the compiled-dashboard case with `ModuleNotFound resolving "src/dashboard/client/dist" (entry point)`. Build the dashboard before treating that case as meaningful, and use 283/1 as A09's before-state. **Correction (implementation audit, 2026-09-26, `docs/audit-2026-09-26-w01-w03-w08a-implementation.md` §3):** that `283/1` is specific to the 1.3.14 binary. With the dashboard client built, the same tree and the same 284 tests give **283 pass / 1 fail on `C:/bun/versions/1.3.14/bun.exe`** and **284 pass / 0 fail on the engines-compliant `C:/bun/bin/bun.exe` (1.4.1)** — 1.3.14 lacks the `--asset` flag that `scripts.build` uses. A09's before-state must therefore name the binary, and the compiled-dashboard case is a tooling gap, not a failing test. Compiled acceptance (A16/A17) needs a fresh `bun run build`: the on-disk waystation.exe is dated 2026-08-28, older than current source, and is git-ignored.

Also run the plugin's Python tests, native UI/component checks, generated-schema consistency check, packaged fixture smoke tests, and focused Node fallback tests. Record actual runtimes, commands, and results. The documentation rewrite itself does not require running the application test suite.

## 17. Delivery sequence and operation

### 17.1 Build sequence

1. Finalize W00's contract names and baseline evidence; convert this plan to bounded tasks only in the next stage.
2. Land W01 persistence hardening and prove interrupted-update recovery.
3. Develop W02 Git context, W03 grammar, and W08 registry/package foundation against frozen interfaces.
4. Land additive evidence schema and W04 reconciliation/transfer.
5. Develop W05 reads and W06 surface slices as their dependencies become ready.
6. Build W07 adapter; prove isolated shared-profile fixture execution.
7. Complete W08 Monitor/discussions and assemble the single package.
8. Run W09 combined acceptance; assess optional live sessions without blocking the baseline.
9. W10 performs one coordinated release, packaging, documentation, and selected rollout.

Parallel scheduling is a later task-management choice, not authorization to spawn agents now.

### 17.2 Worker workflow

1. Bind the worker to an explicit project/worktree/actor.
2. Check the selected ledger, inbox, task brief, and thread.
3. Select a ready task; only a successful locked claim authorizes work.
4. Implement and verify in its worktree. Post progress through canonical messages.
5. For interruption, preserve context and hand off; do not infer release from disconnect.
6. Commit the implementation while still claimed, optionally adding the task trailer.
7. Reconcile the exact hash with explicit close intent using the same owner.
8. If response is uncertain, use the documented retry/state-inspection path.
9. Explicitly regenerate/validate derived state after the mutation.
10. Commit ledger bookkeeping/generated views separately from implementation; push under project policy.

A commit cannot contain its own hash as evidence. With multiple worktrees sharing one ledger, the coordinator/release owner serializes canonical-ledger Git bookkeeping; workers do not independently stage or push the same ledger checkout concurrently. The ledger lock protects records, not Git index operations or competing commits.

Reconciliation checks evidence and ownership, not test success. A review-stage task is not implicitly closed by the new operation; existing review workflows remain separate under Q12.

### 17.3 Release and rollout

Follow docs/release-packaging.md. One owner updates package.json, CLI version, and MCP version together. If 0.5.0 remains the baseline, the planned release is 0.6.0; otherwise use the next appropriate minor. The plugin has its own package metadata without an extra core bump.

Before rollout:

- Recheck the actual Hermes executable/build stamp and backend/plugin API compatibility.
- Preserve prior artifacts and plugin configuration.
- Settle pending mutation intents and coordinate all active Waystation writers.
- Verify source and compiled Windows behavior with fixture ledgers.
- Package the integration subdirectory as one installable Hermes folder; do not require a separate repository or catalog publication.
- Configure explicit project MCP routes, toolsets, plugin grants, and both backend/native enablement.
- Run read-only health checks before selecting real work; mutation smoke tests remain fixtures.
- Record installed versions/paths and the supported compatibility range.
- Document rollback constraints for new intents/metadata and preserve ledgers during uninstall.

Deployment targets are local Waystation and the selected native Hermes app only. No DuckBrain installation, cloud service, remote host, or native Kanban migration is included.

## 18. Next-stage task-list conversion and completion criteria

This rewritten document is the single implementation specification. It replaces the incremental question-and-answer draft; do not create a parallel Hermes/Git plan.

When the user proceeds to the task-list stage:

1. Read Waystation inbox, active tasks, scopes, and existing related work.
2. Reuse/update existing applicable tasks instead of duplicating them.
3. Create bounded task records through createTask/task create, with one W owner, exact contract/acceptance references, path hints, checks, and prerequisites.
4. Split W01 migration, W04 reconciliation/transfer, W06 surfaces, and W08 foundation/Monitor/assembly into independently testable tasks.
5. Keep all initial records todo until intentionally promoted. Dependency satisfaction alone does not promote work.
6. Verify the task graph for cycles, missing prerequisites, duplicate outputs, and unmapped acceptance.
7. Regenerate derived views and validate the ledger.
8. Only then move to agent execution under claims, messages, handoffs, and shared-file ownership.

Design completion means all product choices are integrated, interface/ownership contracts are explicit, and technical uncertainties have named tests and failure behavior. Implementation completion requires the included capabilities, required acceptance groups, documentation, and selected deployment evidence. Optional live-session display and deferred Kanban work do not silently expand that completion condition.

### 18.1 Conversion record (2026-09-26)

Steps 1–8 above were executed against this document, and the ledger now carries it as 30 `todo` records. Nothing was promoted; W00 is the only record with no prerequisites.

| Package | Records |
| --- | --- |
| W00 | task-w00-contract-freeze |
| W01 | task-w01a-lock-acquisition-split, task-w01b-intent-v2, task-w01c-recovery-v1-migration, task-w01d-record-round-trip |
| W02 | task-w02a-process-adapter, task-w02b-object-resolution, task-w02c-source-identity, task-w02d-context-helpers |
| W03 | task-w03-trailer-parser |
| W04 | task-w04a-additive-schema, task-w04b-reconcile-core, task-w04c-lifecycle-guard, task-w04d-transfer |
| W05 | task-w05a-snapshot, task-w05b-bounded-reads |
| W06 | task-w06a-reconcile-surfaces, task-w06b-transfer-surfaces, task-w06c-read-surfaces, task-w06d-diagnostics-contract |
| W07 | task-w07a-binding-store, task-w07b-forwarding, task-w07c-worker-gates |
| W08 | task-w08a-registry-foundation, task-w08b-plugin-backend, task-w08c-native-monitor, task-w08d-package-assembly, task-w08e-live-session-assessment |
| W09 | task-w09-integration-acceptance |
| W10 | task-w10-release |

Each record carries its own acceptance list, path hints limited to existing paths, the repository prompt, and its prerequisites. The split follows step 4: W01 by lock policy, intent format and producer migration; W04 by schema, reconciliation core, lifecycle guard and transfer; W06 by reconcile, transfer, read surfaces and diagnostics; W08 by registry foundation, backend, native Monitor and assembly.

Scope mapping reuses the five existing scopes with no new scope record: W01, W03, W04, W05 and W06d are `scope-core`; W02 is `scope-git`; W06a, W06b and W10 are `scope-cli`; W06c, W07 and W08a/W08d are `scope-mcp`; W08b, W08c and W08e are `scope-dashboard`. The ledger has no canonical command that creates a scope record, so an integration-specific scope was deliberately not invented by hand-writing canonical JSON. Add one only if the Monitor's scope filter needs it, since the snapshot must enumerate the scopes in use.

Reused instead of duplicated (step 2): `task-record-unknown-fields` keeps ownership of the TaskRecord unknown-field decision and is referenced from W01d, which owns the ClaimRecord round-trip fix. The three open `task-bun-native-*` records and `task-audit-mutation-recovery` remain independent tracks and are not prerequisites of this plan.

Step 6 verification: one root (W00), no cycles, no dependency naming a nonexistent task, 124 unique acceptance criteria with no criterion shared between records, and every group A01–A18 named by a record in its owning W package. W08e carries the optional A18 assessment and depends on W09 so it cannot be picked early.

Two ledger-tooling behaviors found while creating the records. The first is a real defect, recorded outside the W packages as `task-cli-list-option-absorption` (priority 1, `scope-cli`); no W record depends on it.

- A list-valued flag given no values absorbs the FOLLOWING option token and its value: Commander parses `--depends-on --description desc` as `["--description","desc"]`. When the captured token fails the record-id rule the whole create is rejected with a misleading `schema_invalid` ("must be filesystem-safe"), which is what rejected W00's first attempt. When the field accepts free text (`--path-hint`, `--acceptance`) the wrong value is written silently with exit status 0, so a record created by a mistyped flag must be read back before it is trusted. Omit the flag entirely for a record with no prerequisites.
- `sync --views` takes no `--actor` flag, unlike the mutating commands, and appends no events; regenerating derived artifacts is not an attributed mutation. Running `validate --views` before that sync reports a `generated_artifact_stale` error per new record.

~~~powershell
& $bun run src/cli/index.ts sync --views
& $bun run src/cli/index.ts validate --project --views
~~~
