# ADR-0005: Track Generated Ledger Markdown

**Status:** Accepted
**Date:** 2026-07-16
**Deciders:** Erez
**Consulted:** Codex

## Context

Waystation has three storage classes: canonical JSON and `events.jsonl`, a
disposable SQLite index, and human-readable Markdown derived from canonical
records. Generated Markdown currently includes `reports/STATUS.md`,
`context/active-work.md`, `context/blocked.md`, and task views under
`views/tasks/`. `context/summary.md` remains hand-authored.

The correction program needs a stable policy before it adds freshness checks
and `sync`. Otherwise a checker could reject deliberately absent output or a
sync command could create unreviewed repository churn.

## Options Considered

### Track all generated Markdown

- A fresh clone immediately has a browsable project status and task views.
- Generated diffs are reviewable alongside the canonical change that caused
  them, and stale tracked output can be detected in CI or local validation.
- Regeneration can create merge churn; deterministic output and explicit
  `--views` keep that cost bounded.

### Generate Markdown optionally, but do not track it

- Avoids generated-file merge churn.
- A clone has no human-readable status until a command runs, and stale-output
  checks cannot protect collaborators who consume the repository directly.

### Ignore all generated Markdown

- Minimizes repository size and churn.
- Makes the ledger less useful as an inspectable, clone-ready coordination
  surface and leaves no reviewed status snapshot.

## Decision

Track generated ledger Markdown. The tracked-file set and `.gitignore` must
agree with this decision:

| Class | Policy | Generation and validation |
|---|---|---|
| Canonical JSON and `events.jsonl` | tracked; authoritative | never regenerated or freshness-compared as output |
| `.waystation/index.sqlite*` | ignored; disposable | rebuilt by `reindex`/`sync`; never committed |
| `reports/STATUS.md`, `context/active-work.md`, `context/blocked.md` | tracked generated output | produced by `report` by default; freshness-validated by `validate --project` and `sync` |
| `views/tasks/*.md` | tracked generated output | produced only by `report --views` or `sync --views`; freshness-validated only when `--views` is requested |
| `context/summary.md` | tracked hand-authored documentation | never overwritten or freshness-validated as generated output |
| `graphify-out/`, executables, logs, bundles | ignored tool/build output | regenerated or rebuilt locally; outside ledger sync |

`report` remains the explicit generation command: default output is the status
report plus active/blocked context, while task views require `--views`. The
future `sync` command must preserve that same selection boundary. It validates
canonical records first, and must not write derived output when canonical
validation fails.

Freshness validation is read-only. Default `validate` does not require a
project filesystem or inspect generated output. `validate --project` compares
the default tracked Markdown to deterministic in-memory output; adding
`--views` additionally compares the tracked task views. Missing optional views
without `--views` are not an error. Generated Markdown is never parsed as
state.

## Consequences

- Clone users can inspect current coordination status without a preliminary
  generation step.
- Contributors regenerate the default output after canonical ledger changes;
  they include `--views` when task-view content changes or is intentionally
  refreshed.
- The sync task must make outputs byte-deterministic, terminate each generated
  file with exactly one LF, and report stale output without rewriting it during
  validation.
- CI may run `validate --project --views` after the sync implementation lands
  to enforce the complete tracked output set.

## Requirements for `task-audit-project-validation-sync`

1. Keep canonical JSON, events, and hand-authored `context/summary.md` out of
   generated-output freshness comparison.
2. Make `validate --project` check only default reports/context; make
   `validate --project --views` also check task views, without mutating files.
3. Make `sync` generate default output and `sync --views` generate the full
   tracked output set, after canonical validation and reindexing.
4. Treat the SQLite index, Graphify output, executable, logs, and bundles as
   disposable/ignored artifacts, not stale generated Markdown.

