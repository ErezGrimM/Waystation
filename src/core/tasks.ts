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

/** Sort key: lower priority number first, then id for stability. */
function byPriorityThenId(a: TaskRecord, b: TaskRecord): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.localeCompare(b.id);
}

export function indexById(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/** All actionable tasks, best-first. */
export function readyTasks(tasks: TaskRecord[]): TaskRecord[] {
  const byId = indexById(tasks);
  return tasks.filter((t) => isActionable(t, byId)).sort(byPriorityThenId);
}

/** The single next task to work on, or null if none are ready. */
export function nextTask(tasks: TaskRecord[]): TaskRecord | null {
  return readyTasks(tasks)[0] ?? null;
}
