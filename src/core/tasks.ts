import type { TaskRecord } from "./schema.ts";

/**
 * A task is "actionable" (a candidate for `next`) when it is not yet done and
 * every one of its dependencies exists and is done. A missing dependency
 * target means the task is NOT ready (surfaced by validation elsewhere).
 */
export function isActionable(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
  if (task.status === "done" || task.status === "wont_do") return false;
  if (task.status === "blocked") return false;
  if (task.status === "in_progress") return false; // already being worked
  for (const dep of task.dependencies) {
    const target = byId.get(dep);
    if (target?.status !== "done") return false;
  }
  return true;
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
