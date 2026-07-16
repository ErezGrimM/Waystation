# ADR-0007: Core Lifecycle Transition Matrix

Task metadata updates never alter status, terminal timestamps, ids, commits, or claims. `claimTask` is the only entry to `in_progress`; it creates the active claim. `releaseTask` returns an owned claim to `ready`; `finishTask` completes it and closes the task. Core status transitions are `todo→ready|wont_do`, `ready→todo|blocked|wont_do`, `blocked→todo|ready|wont_do`, `in_progress→review`, and `review→ready|done`; active claims prohibit generic transition. `done` and `wont_do` reopen only to explicit `todo` or `ready` and clear `closed_at`.

Issues use open status text until `closeIssue`, which sets `status=closed`, resolution, `updated_at`, and `closed_at`. Issue updates preserve unknown fields and immutable identity/creation fields. Every accepted lifecycle operation writes through the durable mutation intent and emits an audited event.
