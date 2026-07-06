# ADR-0002: Implementation Stack — Revised (Go + Embedded React)

**Status:** Superseded by ADR-0001 (2026-07-06) — the project owner chose Bun + TypeScript. This Go proposal is retained for its rationale (the `//go:embed` correction, the distribution analysis), but is not the chosen path. Distribution, Go's main advantage here, was confirmed to be only a secondary priority.
**Date:** 2026-07-06
**Deciders:** Erez (project owner)
**Supersedes:** Reconsiders [ADR-0001](./ADR-0001-implementation-stack.md), which recommended TypeScript/Bun. ADR-0001 is not withdrawn — this is a second, independently-argued option for the same open decision. Neither ADR is confirmed; the project owner has stated the stack is theirs to decide.

## Context

ADR-0001 recommended TypeScript/Bun, built substantially on this claim: a
genuinely rich future dashboard UI (the project owner said "I will want a
better interface in the future") requires a JS ecosystem, and Go's dashboard
story (server-rendered HTML / htmx) hits a ceiling there — so avoiding a
future stack-split rewrite meant picking JS end-to-end.

That claim conflates two separate things: the dashboard *frontend* must run
in a browser and therefore must be JS (unavoidable), but that says nothing
about what language the CLI, core ledger logic, or dashboard *backend* is
written in. A Go binary can embed a fully-built Vite/React SPA directly
(`//go:embed`) and serve it as static assets alongside its API — a standard,
widely-used pattern, not a workaround. This means "rich future UI" and
"single-binary distribution" were never actually in tension. ADR-0001 treated
them as a forced trade-off; they aren't one.

This ADR was requested explicitly ignoring ADR-0001's framing, to check
whether that error changes the recommendation. It does.

## Decision

Recommend **Go for the CLI, core ledger, and dashboard API server**, with the
dashboard **frontend built in Vite + React and embedded into the Go binary**
via `//go:embed`. During development, the Vite dev server proxies API calls
to the running Go binary for hot reload; at release, `go build` produces a
single static binary containing everything.

## High-Level Design

```
                    Waystation binary (single file)
        +-----------------------------------------------+
        |  CLI (cobra)  ------+                          |
        |                     v                          |
        |            Core Ledger API (Go)                |
        |   task/issue/prompt/scope/claim/handoff/...     |
        |   validation - brief generation - events        |
        |                     |                           |
        |            +--------+--------+                  |
        |            v                 v                  |
        |   modernc.org/sqlite   .waystation/*.yaml        |
        |   (pure-Go, no cgo,     events.jsonl             |
        |    disposable index)    (canonical, git-tracked) |
        |                                                  |
        |   net/http + SSE  <- same core, dashboard route  |
        |   //go:embed dist/  (built React/Vite SPA)       |
        +-----------------------------------------------+
                              ^
                              | dev-time only: Vite dev server
                              | proxies API calls for hot reload
                    React/Vite frontend (separate source tree)
```

CLI and dashboard call the same in-process core, so there is no separate
dashboard server process to keep in sync — this satisfies spec §12's
"dashboard should write through the same core write path as the CLI" rule by
construction rather than by discipline.

## Options Considered

### Option A: Go core + embedded React dashboard (this ADR)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — two toolchains (Go + Vite/React), but each is individually simple |
| Cost | Low-medium — more boilerplate than TS for validation, no free type-sharing between frontend/backend |
| Distribution | Best of any option that also supports a rich UI — real single static binary, no runtime dependency, no C toolchain needed (pure-Go SQLite driver) |
| Dashboard UI ceiling | None — frontend is the same React ecosystem as the TS option, just served by a Go backend instead of a Node/Bun one |
| Iteration speed | Slightly slower than pure TS/Bun (ADR-0001's Option A) — dev-proxy setup, no shared types — but not close to Rust's cost |
| Agent-generated code reliability | Good — Go's simplicity and small surface area make it easy for a coding agent to get right on the first pass; fewer config/tooling footguns than a Node/Bun project |

**Pros:** Resolves the distribution weakness that was ADR-0001's one flagged risk, without giving up any UI ambition. No future "rewrite the backend in a real language for distribution" migration. SQLite via `modernc.org/sqlite` avoids CGO entirely, keeping cross-compilation trivial.
**Cons:** Validation ergonomics are weaker than `zod` (more boilerplate, no schema-as-code library at the same maturity). Frontend/backend type-sharing, free in a single-language stack, has to be hand-maintained or generated (e.g. `tygo`). MCP Go SDK is less mature than the TS SDK — relevant only once that deferred phase starts.

### Option B: TypeScript/Bun end-to-end (ADR-0001's recommendation)

Unchanged from ADR-0001: fastest iteration, shared types, best MCP SDK fit,
but the distribution story remains a runtime dependency even with Bun's
`build --compile` (workable, but not a first-class single binary the way
Go's `go build` output is).

### Option C: Rust core + embedded React dashboard

Same embedding trick applies to Rust (`rust-embed` or `include_dir!`), so it
gets the same distribution + UI benefits as Option A. It is not the
recommendation here because the stated priority — iteration speed for the
next 4-6 weeks — is the one thing Rust trades away hardest: slower
compile-edit-test loop, more boilerplate per feature, steeper friction for a
schema that is still actively changing. This was true in ADR-0001 and remains
true; nothing in this reconsideration changes Rust's position.

## Trade-off Analysis

The corrected insight — that dashboard-frontend-must-be-JS does not imply
backend-must-be-JS — removes the strongest argument ADR-0001 had for TS/Bun
(avoiding a future stack-split rewrite) and replaces it with a stack that has
no such rewrite risk at all, at the cost of two toolchains instead of one and
somewhat more validation boilerplate.

Concretely, versus ADR-0001's TS/Bun recommendation:

- **Distribution** improves from "workable, mitigated" to "solved outright."
- **Rich future UI** is unaffected — same React frontend either way.
- **Iteration speed** regresses modestly — two toolchains and a dev-proxy setup versus one language throughout — but does not regress to Rust-level cost.
- **Type safety across the frontend/backend boundary** regresses from free (shared TS types) to something that needs deliberate tooling (generated types or a hand-maintained API contract).
- **MCP** (deferred) regresses from best-in-class SDK to a workable-but-less-mature one, or a small cross-process shim — low weight now since that phase hasn't started.

Net: this option trades a small, bounded amount of iteration speed and
type-sharing convenience for eliminating a real, previously-unresolved risk
(distribution) without sacrificing anything on the UI side. That is a better
trade than ADR-0001 offered, which is why this ADR exists as a competing
proposal rather than a footnote.

## Stack (if this option is chosen)

```text
Go                          - core language, single static binary output
cobra                       - CLI framework
modernc.org/sqlite          - pure-Go SQLite driver, no CGO (disposable index, spec §9)
gopkg.in/yaml.v3            - record parsing
adrg/frontmatter            - Markdown + frontmatter records
go-playground/validator     - schema validation (more boilerplate than zod; honest cost)
net/http + //go:embed       - dashboard API server, embeds built SPA
SSE via http.Flusher        - live ledger updates (§15) and streaming dashboard LLM features
gofrs/flock                 - write-safety locking (§12)
testing + testify           - Go tests
Vite + React                - dashboard frontend (separate source tree, built and embedded)
TanStack Query              - dashboard data fetching/streaming
@modelcontextprotocol/sdk or Go MCP SDK or a thin TS shim - MCP, deferred phase, decide when that work starts
```

## Consequences

- If adopted, ADR-0001 should be marked Superseded rather than deleted — its analysis of Rust and its stack-neutral framing (§23 of the spec) both still hold; only the TS-vs-Go conclusion changes.
- The frontend/backend split means API contracts (task/issue/prompt JSON shapes) need to be treated as a real interface from day one, since there's no shared-type safety net. Worth defining those shapes early, even informally, rather than letting the Go structs and React types drift independently.
- Validation boilerplate is a real, if small, tax versus `zod` — worth checking after the first 2-3 record types are implemented whether it's actually a drag before assuming it isn't.
- MCP SDK maturity in Go is unresolved; defer that evaluation to when the MCP phase actually starts, per the existing sequencing (CLI + dashboard first).

## Action Items

1. [ ] Project owner decides between ADR-0001 (TS/Bun) and ADR-0002 (Go + embedded React) — or neither. Stack remains open until then.
2. [ ] If ADR-0002 is chosen: mark ADR-0001 Superseded, update lessons.md's Core Stack Recommendation and Decision sections (currently flagged "proposed, not confirmed" as of the 2026-07-06 edit) to reflect the new candidate.
3. [ ] If ADR-0002 is chosen: prototype the `//go:embed` + Vite dev-proxy workflow early to confirm the dev-time hot-reload loop is as smooth as expected before committing further.
4. [ ] Either way: smoke-test MCP SDK compatibility (Go SDK, or Bun compatibility with `@modelcontextprotocol/sdk`) once that phase starts, not before.
