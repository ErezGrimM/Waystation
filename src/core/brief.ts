import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getGitState } from "./git.ts";
import { type ActiveClaimOverlap, overlapsForTask } from "./overlap.ts";
import { ledgerPaths } from "./paths.ts";
import { loadTasks } from "./records.ts";
import { type CommandResult, diag, okResult, toResult } from "./result.ts";
import type { TaskRecord } from "./schema.ts";
import { activeClaimForTask, loadClaims } from "./store.ts";

export type BriefBudget = "small" | "medium" | "large" | "full";

export interface ActiveClaimInfo {
  id: string;
  agent: string;
  branch: string | null;
  worktree: string | null;
}

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
  activeClaim: ActiveClaimInfo | null;
  coordinationWarnings: ActiveClaimOverlap[];
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
  const coordinationWarnings = overlapsForTask(root, taskId);

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
    activeClaim: claim
      ? {
          id: claim.id,
          agent: claim.agent,
          branch: claim.branch ?? null,
          worktree: claim.worktree ?? null,
        }
      : null,
    coordinationWarnings,
    nextAction: computeNextAction(task, blockedBy, Boolean(claim)),
  };
}

/** Resolve a task id from the current git branch/worktree claim.
 *  If exactly one active claim matches, returns that task id.
 *  Otherwise returns a diagnostic. */
export function resolveTaskFromGitClaim(root: string): CommandResult<string> {
  const git = getGitState(root);
  if (!git.ok || !git.data) {
    return toResult<string>(
      null,
      git.errors.length ? git.errors : [diag("git_not_repository", { details: { root } })],
    );
  }

  const gitData = git.data;
  const active = loadClaims(root).filter((c) => c.status === "active");
  const matches = active.filter((c) => {
    if (gitData.branch && c.branch === gitData.branch) return true;
    if (c.worktree && gitData.worktree === c.worktree) return true;
    return false;
  });

  const match = matches[0];
  if (matches.length === 1 && match) {
    return okResult(match.task);
  }
  if (matches.length === 0) {
    return toResult<string>(null, [
      diag("no_git_claim_match", {
        details: { branch: gitData.branch, worktree: gitData.worktree },
      }),
    ]);
  }
  return toResult<string>(null, [
    diag("ambiguous_git_claim", {
      details: {
        matches: matches.map((c) => ({ task: c.task, agent: c.agent, branch: c.branch })),
      },
    }),
  ]);
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
    if (b.activeClaim.branch) lines.push(`  branch: ${b.activeClaim.branch}`);
    if (b.activeClaim.worktree) lines.push(`  worktree: ${b.activeClaim.worktree}`);
  }
  if (b.coordinationWarnings.length) {
    lines.push("");
    lines.push("## Coordination warnings");
    for (const warning of b.coordinationWarnings) {
      lines.push(`- ${warning.reason}; coordinate ${warning.task} with ${warning.otherTask}.`);
    }
  }
  lines.push("");
  lines.push(`## Next action`);
  lines.push(b.nextAction);
  return `${lines.join("\n")}\n`;
}
