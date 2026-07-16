export type TaskStatus =
  | "todo"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "wont_do";

export interface TaskReadiness {
  state: "actionable" | "waiting" | "not_eligible";
  reason: string;
  blockers: string[];
}

export const STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["ready", "wont_do"],
  ready: ["todo", "blocked", "wont_do"],
  in_progress: ["review"],
  blocked: ["todo", "ready", "wont_do"],
  review: ["ready", "done"],
  done: [],
  wont_do: [],
};

export function claimDisabledReason(readiness: TaskReadiness, agent: string): string | null {
  if (!agent.trim()) return "Enter an agent name before claiming.";
  if (readiness.state === "waiting") {
    return `Waiting on dependencies: ${readiness.blockers.join(", ")}`;
  }
  if (readiness.state !== "actionable") {
    return `Task is not claimable (${readiness.reason}).`;
  }
  return null;
}
