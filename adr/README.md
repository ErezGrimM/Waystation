# Waystation ADR Guide

Waystation uses Architecture Decision Records (ADRs) to capture important
technical choices in a form that both humans and coding agents can act on.

This guide locally adopts the best ideas from ADR-oriented agent skills and
classic ADR practice:

- Nygard ADRs: short records with context, decision, and consequences.
- MADR: structured Markdown, explicit options, and lifecycle metadata.
- Agent ADR skills: ADRs should be executable specs with implementation plans,
  affected files, and verification criteria.
- ADR tooling conventions: sequential numbering, immutable accepted records,
  and explicit supersession instead of silent rewrites.

## Directory

ADRs live in this directory:

```text
adr/
  README.md
  ADR-0001-implementation-stack.md
  ADR-0002-implementation-stack-revised.md
```

Use this filename pattern:

```text
ADR-0003-short-kebab-title.md
```

Keep one decision per ADR. If a decision changes later, write a new ADR that
supersedes the old one.

## Lifecycle

Use these statuses:

```text
Proposed
Accepted
Rejected
Superseded
Deprecated
```

Rules:

- `Proposed` means the ADR is still under discussion.
- `Accepted` means the project owner has chosen it.
- `Rejected` means it was considered but not chosen.
- `Superseded` means a later ADR replaced it.
- `Deprecated` means the decision is still historical context but should not
  guide new work.
- Do not delete accepted ADRs.
- Do not silently rewrite accepted ADRs to mean something different.
- Small typo and link fixes are fine.

## When To Write An ADR

Write an ADR when a decision:

- chooses a language, framework, database, storage model, or major dependency
- defines a public CLI, file format, API, event schema, or extension point
- changes how the system is built, distributed, tested, or operated
- is expensive to reverse once code exists
- has real alternatives with non-obvious tradeoffs
- future humans or agents will need to understand before changing related code

Do not write an ADR for:

- routine implementation details inside an accepted pattern
- simple bug fixes
- formatting or naming choices covered by tooling
- experiments that are intentionally disposable
- decisions already captured by an existing accepted ADR

When unsure, ask: "Would a future agent avoid a bad change if it knew this
reasoning?" If yes, write or update an ADR.

## Agent Workflow

Agents should follow this workflow before creating or changing an ADR.

### Phase 0: Scan

Before drafting:

- Read existing ADRs in `adr/`.
- Check whether a proposed ADR supersedes or conflicts with an existing ADR.
- Read relevant project docs such as `agentledger-spec.md`, `lessons.md`, and
  `.waystation/context/summary.md`.
- Inspect related files once implementation exists.
- Note concrete constraints, not vibes.

### Phase 1: Capture Intent

Ask focused questions one at a time when the decision is unclear.

Before writing the ADR, produce a short intent summary and get confirmation
from the project owner for major decisions.

### Phase 2: Draft

Draft the ADR using the template below.

The ADR should be specific enough that an agent can implement the decision
without rediscovering the tradeoff.

### Phase 3: Review

Review the ADR against the checklist in this file before treating it as ready.

## Template

Use this template for new ADRs.

```markdown
# ADR-0000: Title

**Status:** Proposed
**Date:** YYYY-MM-DD
**Deciders:** Erez
**Consulted:** Optional
**Informed:** Optional
**Supersedes:** Optional ADR links
**Superseded by:** Optional ADR links

## Context

What problem or constraint forces this decision?

Include:

- relevant project goals
- current state
- constraints
- non-goals
- why this decision matters now

## Decision Drivers

- Driver 1
- Driver 2
- Driver 3

## Options Considered

### Option A: Name

Good:

- Benefit

Bad:

- Cost or risk

Neutral:

- Important fact that is neither clearly good nor bad

### Option B: Name

Good:

- Benefit

Bad:

- Cost or risk

Neutral:

- Important fact

## Decision

State the chosen option clearly.

If the ADR is still proposed, state the current recommendation instead of
pretending a final decision has been made.

## Consequences

Positive:

- What gets better?

Negative:

- What gets harder?

Risks:

- What could go wrong?
- How will we mitigate it?

## Implementation Plan

Affected files or areas:

- `path/to/file`
- `path/to/directory/`

Steps:

1. Step one
2. Step two
3. Step three

Patterns to follow:

- Existing pattern or rule

Patterns to avoid:

- Anti-pattern or rejected approach

## Verification

- [ ] Concrete check or test
- [ ] Concrete check or test
- [ ] Documentation or Waystation record updated

## Waystation Records

Related tasks:

- `task-id`

Related decisions:

- `.waystation/decisions/decision-id.yaml`

Related prompts/scopes:

- `prompt-id`
- `scope-id`

## Links

- Relevant docs or source links
```

## Review Checklist

An ADR is ready for human decision when:

- [ ] It states the status accurately.
- [ ] It captures one decision, not several loosely related decisions.
- [ ] The context explains why the decision matters now.
- [ ] The options are real alternatives.
- [ ] Rejected options have rejection rationale.
- [ ] Consequences include both benefits and costs.
- [ ] Non-goals or deferrals are explicit where relevant.
- [ ] The implementation plan names affected files or areas.
- [ ] Verification criteria are concrete and testable.
- [ ] Related Waystation tasks or decisions are linked when applicable.
- [ ] It does not contradict accepted ADRs without superseding them.
- [ ] A coding agent could implement from the ADR without asking broad
  follow-up questions.

## Code And ADR Linking

When code exists and a decision governs a non-obvious implementation choice,
link sparingly from code to the ADR:

```go
// See ADR-0002 for why the dashboard API is served from the Go binary.
```

Avoid putting ADR references everywhere. Use them only where they prevent a
future accidental rewrite or dependency change.

## Waystation Decision Records

Once an ADR is accepted, also create or update the matching Waystation decision
record under:

```text
.waystation/decisions/
```

Use the spec's decision record shape:

```yaml
id: decision-implementation-stack
title: Use Go with embedded React for Waystation V1
status: accepted
scope: scope-core
task:

created_at: 2026-07-06T00:00:00+03:00
decided_by: Erez

context: |
  Short summary of why the decision was needed.

decision: |
  Short statement of the accepted decision.

consequences:
  - Consequence one.
  - Consequence two.
```

The ADR is the detailed rationale. The Waystation decision record is the
structured index entry that agents and future `waystation brief` commands can
surface.

## Current ADRs

| ADR | Status | Summary |
|---|---|---|
| [ADR-0001](./ADR-0001-implementation-stack.md) | Proposed | TypeScript/Bun implementation stack |
| [ADR-0002](./ADR-0002-implementation-stack-revised.md) | Proposed | Go core/API with embedded React dashboard |

No implementation stack ADR has been accepted yet.
