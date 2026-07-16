# ADR-0006: Replay Durable Mutation Intents

**Status:** Accepted
**Date:** 2026-07-17

## Decision

Multi-record canonical mutations use a single replay journal at
`.waystation/mutation-intent.json`. While holding the ledger lock, a mutation
first atomically writes its versioned intent containing exact record targets,
target values, and ordered events. Recovery then writes every target value,
appends the event batch once using the intent id as an event marker, and removes
the intent only after completion.

The next `withLedgerLock` call always recovers a pending intent before running
new work. Replaying is idempotent: record writes replace the same values and an
existing event marker suppresses duplicate event append. Malformed or unsafe
intent files stop recovery and surface `mutation_intent_invalid` through
validation or the normal coded-error path.

## Failure Boundaries

1. Before intent persistence: no accepted mutation exists.
2. After intent persistence, during record writes: recovery rewrites all target
   records.
3. After record writes, during event append: recovery appends the whole marked
   batch once.
4. After events, before intent removal: recovery observes the marker, skips
   duplicate events, and removes the intent.

This is completion/replay, not rollback. Events are ordered after durable target
records; the intent is the durable record of accepted work until the event batch
is complete. Claims, release/finish, commit attachment, issue creation,
handoffs, and messages use this primitive. Single-record mutations also use it
where they emit an event, keeping one recovery contract.
