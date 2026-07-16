import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getGitState } from "./git.ts";
import { enrichFromGraph, loadGraphData } from "./graph.ts";
import { type ActiveClaimOverlap, overlapsForTask } from "./overlap.ts";
import { ledgerPaths } from "./paths.ts";
import { loadTasks } from "./records.ts";
import { type CommandResult, diag, okResult, toResult } from "./result.ts";
import type { TaskRecord } from "./schema.ts";
import { activeClaimForTask, loadClaims } from "./store.ts";
import { type TaskReadiness, taskReadiness } from "./tasks.ts";

export type BriefBudget = "small" | "medium" | "large" | "full";
export const BRIEF_BUDGETS = ["small", "medium", "large", "full"] as const;

export interface ActiveClaimInfo {
  id: string;
  agent: string;
  branch: string | null;
  worktree: string | null;
}

export interface Brief {
  budget: BriefBudget;
  task: {
    id: string;
    title: string;
    status: string;
    priority: number;
    scope: string | null;
    commits: string[];
    readiness: TaskReadiness;
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
  relatedFiles?: string[];
  concepts?: string[];
  impactHints?: string[];
}

export function parseBriefBudget(value: string | undefined | null): CommandResult<BriefBudget> {
  const budget = value ?? "medium";
  if ((BRIEF_BUDGETS as readonly string[]).includes(budget)) {
    return okResult(budget as BriefBudget);
  }
  return toResult<BriefBudget>(null, [
    diag("invalid_brief_budget", {
      details: { budget, supported: [...BRIEF_BUDGETS] },
    }),
  ]);
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

function computeNextAction(task: TaskRecord, readiness: TaskReadiness, claimed: boolean): string {
  if (task.status === "done") return "Task is done; nothing to do.";
  if (task.status === "wont_do") return "Task is won't-do; skip.";
  if (task.status === "todo") return "Task is in the backlog; move it to ready when intentional.";
  if (task.status === "blocked") return "Task is marked blocked; resolve the blocker.";
  if (task.status === "review") return "Task is awaiting review.";
  if (task.status === "in_progress") {
    return claimed
      ? "Claimed and in progress; implement against the acceptance criteria."
      : "Task is in progress without an active claim; validate and repair the ledger.";
  }
  if (readiness.state === "waiting") {
    return `Waiting: finish ${readiness.blockers.join(", ")} first.`;
  }
  if (readiness.state === "actionable") {
    return `Claim it: waystation task claim ${task.id} --agent <you>.`;
  }
  return "Task is not eligible to start.";
}

/** Build a task-scoped brief (spec §10) with deterministic section tiers. */
export function buildBrief(root: string, taskId: string, budget: BriefBudget = "medium"): Brief {
  const tasks = loadTasks(root);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const dependencies = task.dependencies.map((id) => ({
    id,
    status: byId.get(id)?.status ?? ("missing" as const),
  }));
  const readiness = taskReadiness(task, byId);
  const blockedBy = readiness.blockers;
  const claim = activeClaimForTask(root, taskId);
  const coordinationWarnings = overlapsForTask(root, taskId);

  const includeMedium = budget === "medium" || budget === "large" || budget === "full";
  const includeLarge = budget === "large" || budget === "full";
  const includeFull = budget === "full";

  const graphResult = includeLarge ? loadGraphData(root) : okResult(null);
  const enrichment =
    graphResult.ok && graphResult.data
      ? enrichFromGraph(graphResult.data, {
          pathHints: task.path_hints ?? [],
          taskTitle: task.title,
          taskDescription: task.description,
          taskScope: task.scope ?? undefined,
        })
      : { relatedFiles: [], concepts: [], impactHints: [] };

  return {
    budget,
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      scope: task.scope ?? null,
      commits: task.commits ?? [],
      readiness,
    },
    goal: (task.description ?? task.title).trim(),
    acceptance: task.acceptance,
    dependencies,
    blockedBy,
    scopeRules: includeMedium ? scopeRules(root, task.scope) : [],
    prompts: includeMedium ? task.prompts : [],
    activeClaim:
      includeMedium && claim
        ? {
            id: claim.id,
            agent: claim.agent,
            branch: claim.branch ?? null,
            worktree: claim.worktree ?? null,
          }
        : null,
    coordinationWarnings: includeLarge ? coordinationWarnings : [],
    nextAction: computeNextAction(task, readiness, Boolean(claim)),
    relatedFiles: includeLarge ? enrichment.relatedFiles : [],
    concepts: includeLarge ? enrichment.concepts : [],
    impactHints: includeFull ? enrichment.impactHints : [],
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
    `status: ${b.task.status}  readiness: ${b.task.readiness.state} (${b.task.readiness.reason})  priority: ${b.task.priority}  scope: ${b.task.scope ?? "-"}  budget: ${b.budget}`,
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
  if (b.task.commits.length) {
    lines.push("");
    lines.push("## Commits");
    for (const commit of b.task.commits) lines.push(`- ${commit}`);
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
  if (b.relatedFiles && b.relatedFiles.length > 0) {
    lines.push("");
    lines.push("## Related files");
    for (const file of b.relatedFiles) lines.push(`- ${file}`);
  }
  if (b.concepts && b.concepts.length > 0) {
    lines.push("");
    lines.push("## Concepts");
    for (const concept of b.concepts) lines.push(`- ${concept}`);
  }
  if (b.impactHints && b.impactHints.length > 0) {
    lines.push("");
    lines.push("## Impact hints");
    for (const hint of b.impactHints) lines.push(`- ${hint}`);
  }
  lines.push("");
  lines.push(`## Next action`);
  lines.push(b.nextAction);
  return `${lines.join("\n")}\n`;
}
