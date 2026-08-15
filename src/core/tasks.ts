import type { TaskRecord, TaskStatus } from "./schema.ts";

export type ReadinessState = "actionable" | "waiting" | "not_eligible";

export type ReadinessReason = "declared_ready" | "unmet_dependencies" | `status_${TaskStatus}`;

export interface TaskReadiness {
  state: ReadinessState;
  reason: ReadinessReason;
  blockers: string[];
}

/** The minimal canonical task shape needed to derive readiness. */
export type ReadinessTask = Pick<TaskRecord, "id" | "status" | "dependencies">;

/**
 * A dependency is satisfied when its target is `done` OR `wont_do`. `wont_do`
 * is a legitimate terminal state ("decided not to do it"); treating it as
 * unsatisfied would permanently, silently block every dependent (audit H6).
 */
export function dependencySatisfied(target: ReadinessTask | undefined): boolean {
  return target?.status === "done" || target?.status === "wont_do";
}

/**
 * Derive readiness from declared status plus the current dependency graph.
 * Readiness is never persisted: callers must compute it from a fresh canonical
 * snapshot whenever they select, render, validate, or mutate a task.
 */
export function taskReadiness(
  task: ReadinessTask,
  byId: ReadonlyMap<string, ReadinessTask>,
): TaskReadiness {
  if (task.status !== "ready") {
    return {
      state: "not_eligible",
      reason: `status_${task.status}`,
      blockers: [],
    };
  }

  const blockers = task.dependencies.filter(
    (dependency) => !dependencySatisfied(byId.get(dependency)),
  );
  if (blockers.length > 0) {
    return { state: "waiting", reason: "unmet_dependencies", blockers };
  }

  return { state: "actionable", reason: "declared_ready", blockers: [] };
}

export function isActionable(
  task: ReadinessTask,
  byId: ReadonlyMap<string, ReadinessTask>,
): boolean {
  return taskReadiness(task, byId).state === "actionable";
}

/**
 * Sort key: lower priority number first; among equal priorities, earlier
 * `created_at` first (records missing `created_at` sort as earliest); `id` is
 * the final unique tiebreak. ADR-0008. `created_at` is compared by real
 * instant via `Date.parse` (offset-aware), never lexically, so records
 * authored under different timezone offsets order correctly.
 */
export function byPriorityThenCreatedAtThenId(
  a: Pick<TaskRecord, "id" | "priority"> & { created_at?: string | null },
  b: Pick<TaskRecord, "id" | "priority"> & { created_at?: string | null },
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aInstant = a.created_at ? Date.parse(a.created_at) : NaN;
  const bInstant = b.created_at ? Date.parse(b.created_at) : NaN;
  const aRank = Number.isNaN(aInstant) ? Number.NEGATIVE_INFINITY : aInstant;
  const bRank = Number.isNaN(bInstant) ? Number.NEGATIVE_INFINITY : bInstant;
  if (aRank !== bRank) return aRank - bRank;
  return a.id.localeCompare(b.id);
}

export function indexById(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/** All actionable tasks, best-first. */
export function readyTasks(tasks: TaskRecord[]): TaskRecord[] {
  const byId = indexById(tasks);
  return tasks.filter((t) => isActionable(t, byId)).sort(byPriorityThenCreatedAtThenId);
}

/**
 * Todo tasks whose dependencies are all satisfied. These are candidates for
 * intentional promotion to `ready` during a migration audit. They are never
 * promoted automatically: readiness requires the declared `ready` status, so
 * listing them here changes nothing by itself.
 */
export function auditPromotableTasks(tasks: TaskRecord[]): TaskRecord[] {
  const byId = indexById(tasks);
  return tasks
    .filter(
      (t) => t.status === "todo" && t.dependencies.every((d) => dependencySatisfied(byId.get(d))),
    )
    .sort(byPriorityThenCreatedAtThenId);
}

/** The single next task to work on, or null if none are ready. */
export function nextTask(tasks: TaskRecord[]): TaskRecord | null {
  return readyTasks(tasks)[0] ?? null;
}
