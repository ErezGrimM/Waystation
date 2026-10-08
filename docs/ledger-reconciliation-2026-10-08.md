# Ledger reconciliation after the Hermes proof of concept

The local `main` checkout contained 17 commits beyond `origin/main` and uncommitted
Hermes POC records. The commits cover the Bun CLI and dashboard changes, the
native Hermes page, the one-project monitor, and the demo MCP workflow. The
remote had no commits absent from the local checkout.

The POC 1 task and claim were completed through Waystation and have matching
status and completion events. POC 3 was changed from `ready` to `blocked` by a
direct record edit, without a status event. On 2026-10-08, a version-2 mutation
intent reconciled that transition: it atomically updated the task timestamp and
appended a `task.status_changed` event from `ready` to `blocked`, with actor
`codex-reconcile` and a reason identifying the reconstruction. The POC 3 task
remains blocked because the native monitor was not refreshed during the Hermes
agent's demo workflow. Its blocker note now reflects the later verified Hermes
session, which superseded the first direct-client attempt.

Four local closure commits directly changed older task records without emitting
status events or attaching the implementation commits to those records:
`5180cf9` (native CLI parser), `868107e` (dashboard build), `b892bb9`
(dashboard router), and `6db862d` (POC 2 monitor). Their current `done` states
and closure times are preserved. Reconstructing intermediate lifecycle states
or claim events would invent actions that did not happen; this document records
the gap rather than fabricating that history.

Three historical demo artifacts remain visible in the primary ledger:

- `task-new` has a `task.created` event from an earlier CLI experiment, but no
  task record. Its mutation is
  `mutation-task-create-task-new-20261005-233410-5b97aa2b`.
- Two messages on `task-poc-demo` were accidentally written to the primary
  ledger during an earlier POC 3 run. Their mutations are
  `mutation-message-message-task-poc-demo-agent-poc-3-20261006-015134-cjqn`
  and `mutation-message-message-task-poc-demo-agent-poc-3-20261006-015134-63a6`.
  The actual demo task lives in the isolated scratch ledger, where later runs
  have their own messages. These two primary-ledger messages produce
  `orphan_thread` warnings.

These canonical events and message records were retained rather than removed
from append-only history or merged into the production task list. The supported
`waystation repair` command handles JSONL formatting, not semantic relocation.
Future semantic repair tooling should make any relocation explicit and
auditable. Regenerated reports and views reflect the current task records;
`waystation validate --project --views` reports zero errors and the two known
orphan-thread warnings.
