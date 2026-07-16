import { getGitState } from "./git.ts";
import { type LoadedTask, loadTaskFiles } from "./records.ts";
import { type ClaimRecord, isCommitRef, type TaskRecord } from "./schema.ts";
import {
  activeClaimForTask,
  appendEventUnlocked,
  withLedgerLock,
  writeClaim,
  writeJsonAtomic,
} from "./store.ts";
import { indexById, taskReadiness } from "./tasks.ts";
import { idStamp, nowIso, safeIdPart } from "./time.ts";

export class MutationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "MutationError";
    this.code = code;
  }
}

export interface ClaimGitContext {
  branch?: string | null;
  worktree?: string | null;
}

export interface FinishTaskOptions {
  commits?: string[];
  commitHead?: boolean;
}

/**
 * Find a JSON task record by id, returning the record and the file it lives in
 * so the mutation writes back to that exact file (not an assumed `${id}.json`).
 */
function requireLoadedTask(tasks: LoadedTask[], id: string): LoadedTask {
  const found = tasks.find((t) => t.task.id === id);
  if (!found) throw new MutationError(`no such task: ${id}`, "no_such_task");
  return found;
}

function requireTask(root: string, id: string): LoadedTask {
  return requireLoadedTask(loadTaskFiles(root), id);
}

function writeTask(file: string, task: TaskRecord): void {
  writeJsonAtomic(file, task);
}

function claimGitContext(root: string, override: ClaimGitContext = {}): Required<ClaimGitContext> {
  const state = getGitState(root);
  const derived = state.data;
  return {
    branch: override.branch !== undefined ? override.branch : (derived?.branch ?? null),
    worktree: override.worktree !== undefined ? override.worktree : (derived?.worktree ?? null),
  };
}

function headCommit(root: string): string | null {
  const state = getGitState(root);
  return state.data?.head ?? null;
}

function normalizeCommits(commits: string[]): string[] {
  const normalized: string[] = [];
  for (const commit of commits.map((c) => c.trim()).filter(Boolean)) {
    if (!isCommitRef(commit)) {
      throw new MutationError(`invalid commit reference: ${commit}`, "invalid_commit_ref");
    }
    if (!normalized.includes(commit)) normalized.push(commit);
  }
  return normalized;
}

function taskWithCommits(task: TaskRecord, commits: string[]): TaskRecord {
  const existing = task.commits ?? [];
  const merged = [...existing];
  for (const commit of commits) {
    if (!merged.includes(commit)) merged.push(commit);
  }
  return { ...task, commits: merged };
}

export async function addTaskCommits(
  root: string,
  id: string,
  commits: string[],
  agent: string = "system",
  now: Date = new Date(),
): Promise<TaskRecord> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    const refs = normalizeCommits(commits);
    if (refs.length === 0) return task;
    const ts = nowIso(now);
    const updated = { ...taskWithCommits(task, refs), updated_at: ts };
    appendEventUnlocked(root, {
      type: "task.commits_attached",
      task: id,
      commits: refs,
      actor: agent,
      ts,
    });
    writeTask(file, updated);
    return updated;
  });
}

/** Claim a task: create an active claim and move the task to in_progress. */
export async function claimTask(
  root: string,
  id: string,
  agent: string,
  now: Date = new Date(),
  gitContext?: ClaimGitContext,
): Promise<ClaimRecord> {
  return withLedgerLock(root, () => {
    // Load the task and its dependency graph only after acquiring the ledger
    // lock. Selection is advisory; this fresh canonical snapshot is the
    // authoritative claim-time eligibility check.
    const loaded = loadTaskFiles(root);
    const { task, file } = requireLoadedTask(loaded, id);
    if (task.status === "done" || task.status === "wont_do") {
      throw new MutationError(`task ${id} is ${task.status}; cannot claim`, "task_done");
    }
    if (activeClaimForTask(root, id)) {
      throw new MutationError(`task ${id} already has an active claim`, "task_already_claimed");
    }
    const readiness = taskReadiness(task, indexById(loaded.map((entry) => entry.task)));
    if (readiness.state === "waiting") {
      throw new MutationError(
        `task ${id} is waiting on: ${readiness.blockers.join(", ")}`,
        "task_not_ready",
      );
    }
    if (readiness.state !== "actionable") {
      throw new MutationError(
        `task ${id} is ${task.status}; only ready tasks can be claimed`,
        "invalid_transition",
      );
    }
    const ts = nowIso(now);
    const context = claimGitContext(root, gitContext);
    const claim: ClaimRecord = {
      id: `claim-${safeIdPart(id)}-${safeIdPart(agent)}-${idStamp(now)}`,
      task: id,
      agent,
      status: "active",
      branch: context.branch,
      worktree: context.worktree,
      claimed_at: ts,
      released_at: null,
      completed_at: null,
    };
    const from = task.status;
    // Write-ahead: append events before record writes so the event log is
    // always a superset of applied record changes (see H4 in the audit).
    appendEventUnlocked(root, {
      type: "task.claimed",
      task: id,
      claim: claim.id,
      actor: agent,
      branch: claim.branch,
      worktree: claim.worktree,
      ts,
    });
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: id,
      from,
      to: "in_progress",
      actor: agent,
      ts,
    });
    writeClaim(root, claim);
    writeTask(file, { ...task, status: "in_progress", updated_at: ts });
    return claim;
  });
}

/** Release an active claim and move the task back to ready. */
export async function releaseTask(
  root: string,
  id: string,
  agent: string,
  now: Date = new Date(),
): Promise<void> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    const claim = activeClaimForTask(root, id);
    if (!claim) throw new MutationError(`task ${id} has no active claim`, "no_active_claim");
    if (claim.agent !== agent) {
      throw new MutationError(
        `task ${id} is claimed by ${claim.agent}, not ${agent}`,
        "claim_owner_mismatch",
      );
    }
    const ts = nowIso(now);
    const from = task.status;
    // Write-ahead: events first, then records (see H4 in the audit).
    appendEventUnlocked(root, {
      type: "claim.released",
      task: id,
      claim: claim.id,
      actor: agent,
      ts,
    });
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: id,
      from,
      to: "ready",
      actor: agent,
      ts,
    });
    writeClaim(root, { ...claim, status: "released", released_at: ts });
    // Released tasks return to `ready` (actionable) by design; claims are only
    // allowed from todo/ready, so no other prior status can be lost here.
    writeTask(file, { ...task, status: "ready", updated_at: ts });
  });
}

/** Finish a task: mark it done and complete any active claim. */
export async function finishTask(
  root: string,
  id: string,
  agent: string,
  now: Date = new Date(),
  options: FinishTaskOptions = {},
): Promise<void> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    if (task.status === "done") throw new MutationError(`task ${id} is already done`, "task_done");
    if (task.status === "wont_do") {
      throw new MutationError(`task ${id} is wont_do; cannot finish`, "invalid_transition");
    }
    const ts = nowIso(now);
    const claim = activeClaimForTask(root, id);
    if (claim && claim.agent !== agent) {
      throw new MutationError(
        `task ${id} is claimed by ${claim.agent}, not ${agent}`,
        "claim_owner_mismatch",
      );
    }
    const refs = normalizeCommits([
      ...(options.commits ?? []),
      ...(options.commitHead ? [headCommit(root) ?? ""] : []),
    ]);
    const from = task.status;
    // Write-ahead: events first, then records (see H4 in the audit).
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: id,
      from,
      to: "done",
      actor: agent,
      ts,
    });
    if (claim) {
      appendEventUnlocked(root, {
        type: "claim.completed",
        task: id,
        claim: claim.id,
        actor: agent,
        ts,
      });
    }
    if (refs.length > 0) {
      appendEventUnlocked(root, {
        type: "task.commits_attached",
        task: id,
        commits: refs,
        actor: agent,
        ts,
      });
    }
    if (claim) {
      writeClaim(root, { ...claim, status: "completed", completed_at: ts });
    }
    writeTask(file, {
      ...taskWithCommits(task, refs),
      status: "done",
      updated_at: ts,
      closed_at: ts,
    });
  });
}
