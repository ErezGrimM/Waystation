import type { Diagnostic } from "./result.ts";
import { diag } from "./result.ts";
import type { ClaimRecord, TaskRecord } from "./schema.ts";

type Event = Record<string, unknown>;

function missing(diags: Diagnostic[], mutation: string, task: string, expected: string): void {
  diags.push(
    diag("event_history_incomplete", {
      message: `${mutation}: missing ${expected} for ${task}`,
      details: { mutation, task, expected },
    }),
  );
}

/** Check journaled lifecycle batches and replay status transitions in append order. */
export function addEventIntegrityDiagnostics(
  diags: Diagnostic[],
  tasks: TaskRecord[],
  claims: ClaimRecord[],
  events: Event[],
): void {
  const batches = new Map<string, Event[]>();
  const lastStatus = new Map<string, string>();
  const claimed = new Set<string>();
  const completed = new Set<string>();

  for (const event of events) {
    const mutation = event.mutation;
    if (typeof mutation === "string") {
      const batch = batches.get(mutation) ?? [];
      batch.push(event);
      batches.set(mutation, batch);
    }
    if (event.type === "task.claimed" && typeof event.claim === "string") claimed.add(event.claim);
    if (event.type === "claim.completed" && typeof event.claim === "string")
      completed.add(event.claim);
    if (
      (event.type !== "task.status_changed" && event.type !== "task.reopened") ||
      typeof event.task !== "string"
    )
      continue;
    const previous = lastStatus.get(event.task);
    if (previous !== undefined && previous !== event.from) {
      diags.push(
        diag("event_status_divergence", {
          message: `${event.task}: status chain has ${previous}, next event starts at ${String(event.from)}`,
          details: { task: event.task, mutation, previous, from: event.from },
        }),
      );
    }
    if (typeof event.to === "string") lastStatus.set(event.task, event.to);
  }

  for (const [mutation, batch] of batches) {
    if (!mutation.startsWith("mutation-claim-") && !mutation.startsWith("mutation-finish-"))
      continue;
    const first = batch[0];
    if (!first) continue;
    const task = typeof first.task === "string" ? first.task : "unknown task";
    const expected = mutation.startsWith("mutation-claim-")
      ? ["task.claimed", "task.status_changed"]
      : [
          "task.status_changed",
          ...(batch.some((e) => e.type === "claim.completed") ? ["claim.completed"] : []),
        ];
    // A finish may have lost claim.completed entirely. The completed claim
    // record below detects that case even when this batch contains only status.
    for (let index = 0; index < expected.length; index++) {
      const event = batch[index];
      if (
        !event ||
        event.type !== expected[index] ||
        (event.intent_event !== undefined && event.intent_event !== String(index))
      ) {
        missing(diags, mutation, task, expected[index] ?? "event");
      }
    }
    if (
      mutation.startsWith("mutation-claim-") &&
      !batch.some((e) => e.type === "task.status_changed" && e.to === "in_progress")
    ) {
      missing(diags, mutation, task, "ready → in_progress");
    }
    if (
      mutation.startsWith("mutation-finish-") &&
      !batch.some((e) => e.type === "task.status_changed" && e.to === "done")
    ) {
      missing(diags, mutation, task, "status → done");
    }
  }

  for (const claim of claims) {
    const claimMutation = `mutation-claim-${claim.id}`;
    if (!claimed.has(claim.id)) missing(diags, claimMutation, claim.task, "task.claimed");
    if (claim.status === "completed" && !completed.has(claim.id)) {
      const finish = [...batches.entries()].find(([, batch]) =>
        batch.some(
          (event) =>
            event.type === "task.status_changed" &&
            event.task === claim.task &&
            event.to === "done" &&
            event.ts === claim.completed_at,
        ),
      );
      missing(
        diags,
        finish?.[0] ?? `mutation-finish-${claim.task} (unknown id)`,
        claim.task,
        `claim.completed for ${claim.id}`,
      );
    }
  }

  for (const task of tasks) {
    const status = lastStatus.get(task.id);
    if (status !== undefined && status !== task.status) {
      diags.push(
        diag("event_status_divergence", {
          message: `${task.id}: last event says ${status}, record says ${task.status}`,
          details: { task: task.id, event_status: status, record_status: task.status },
        }),
      );
    }
  }
}
