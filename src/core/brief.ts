import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { loadTasks } from "./records.ts";
import type { TaskRecord } from "./schema.ts";
import { activeClaimForTask } from "./store.ts";

export type BriefBudget = "small" | "medium" | "large" | "full";

export interface Brief {
  task: {
    id: string;
    title: string;
    status: string;
    priority: number;
    scope: string | null;
  };
  goal: string;
  acceptance: string[];
  dependencies: Array<{ id: string; status: string | "missing" }>;
  blockedBy: string[];
  scopeRules: string[];
  prompts: string[];
  activeClaim: { id: string; agent: string } | null;
  nextAction: string;
}

/** Read the `rules` array from a scope record (JSON), if present. */
function scopeRules(root: string, scope: string | null | undefined): string[] {
  if (!scope) return [];
  const file = join(ledgerPaths(root).ledger, "scopes", `${scope}.json`);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { rules?: string[] };
    return data.rules ?? [];
  } catch {
    return [];
  }
}

function computeNextAction(task: TaskRecord, blockedBy: string[], claimed: boolean): string {
  if (task.status === "done") return "Task is done; nothing to do.";
  if (task.status === "wont_do") return "Task is won't-do; skip.";
  if (blockedBy.length > 0) return `Blocked: finish ${blockedBy.join(", ")} first.`;
  if (task.status === "blocked") return "Task is marked blocked; resolve the blocker.";
  if (!claimed) return `Claim it: waystation task claim ${task.id} --agent <you>.`;
  return "Claimed and ready; implement against the acceptance criteria.";
}

/** Build a task-scoped brief (spec §10). Budget is accepted but currently
 * produces one sensible brief regardless of level (tiers are future work). */
export function buildBrief(root: string, taskId: string, _budget: BriefBudget = "medium"): Brief {
  const tasks = loadTasks(root);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const dependencies = task.dependencies.map((id) => ({
    id,
    status: byId.get(id)?.status ?? ("missing" as const),
  }));
  const blockedBy = dependencies.filter((d) => d.status !== "done").map((d) => d.id);
  const claim = activeClaimForTask(root, taskId);

  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      scope: task.scope ?? null,
    },
    goal: (task.description ?? task.title).trim(),
    acceptance: task.acceptance,
    dependencies,
    blockedBy,
    scopeRules: scopeRules(root, task.scope),
    prompts: task.prompts,
    activeClaim: claim ? { id: claim.id, agent: claim.agent } : null,
    nextAction: computeNextAction(task, blockedBy, Boolean(claim)),
  };
}

/** Render a brief as human-readable text. */
export function renderBrief(b: Brief): string {
  const lines: string[] = [];
  lines.push(`# ${b.task.id} — ${b.task.title}`);
  lines.push(
    `status: ${b.task.status}  priority: ${b.task.priority}  scope: ${b.task.scope ?? "-"}`,
  );
  lines.push("");
  lines.push("## Goal");
  lines.push(b.goal);
  if (b.acceptance.length) {
    lines.push("");
    lines.push("## Acceptance");
    for (const a of b.acceptance) lines.push(`- ${a}`);
  }
  if (b.dependencies.length) {
    lines.push("");
    lines.push("## Dependencies");
    for (const d of b.dependencies) lines.push(`- ${d.id} [${d.status}]`);
  }
  if (b.scopeRules.length) {
    lines.push("");
    lines.push("## Scope rules");
    for (const r of b.scopeRules) lines.push(`- ${r}`);
  }
  if (b.prompts.length) {
    lines.push("");
    lines.push(`## Prompts: ${b.prompts.join(", ")}`);
  }
  if (b.activeClaim) {
    lines.push("");
    lines.push(`## Active claim: ${b.activeClaim.agent} (${b.activeClaim.id})`);
  }
  lines.push("");
  lines.push(`## Next action`);
  lines.push(b.nextAction);
  return `${lines.join("\n")}\n`;
}
