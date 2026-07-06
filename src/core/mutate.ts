import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { loadTasks } from "./records.ts";
import type { ClaimRecord, TaskRecord } from "./schema.ts";
import {
  activeClaimForTask,
  appendEventUnlocked,
  withLedgerLock,
  writeClaim,
  writeJsonAtomic,
} from "./store.ts";
import { idStamp, nowIso, safeIdPart } from "./time.ts";

export class MutationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "MutationError";
    this.code = code;
  }
}

function taskFile(root: string, id: string): string {
  return join(ledgerPaths(root).tasks, `${id}.json`);
}

/** Find a JSON task record by id, or throw. (Mutations target JSON records.) */
function requireTask(root: string, id: string): TaskRecord {
  const task = loadTasks(root).find((t) => t.id === id);
  if (!task) throw new MutationError(`no such task (as JSON): ${id}`, "no_such_task");
  return task;
}

function writeTask(root: string, task: TaskRecord): void {
  writeJsonAtomic(taskFile(root, task.id), task);
}

/** Claim a task: create an active claim and move the task to in_progress. */
export async function claimTask(
  root: string,
  id: string,
  agent: string,
  now: Date = new Date(),
): Promise<ClaimRecord> {
  return withLedgerLock(root, () => {
    const task = requireTask(root, id);
    if (task.status === "done" || task.status === "wont_do") {
      throw new MutationError(`task ${id} is ${task.status}; cannot claim`, "task_done");
    }
    if (activeClaimForTask(root, id)) {
      throw new MutationError(`task ${id} already has an active claim`, "task_already_claimed");
    }
    const ts = nowIso(now);
    const claim: ClaimRecord = {
      id: `claim-${safeIdPart(id)}-${safeIdPart(agent)}-${idStamp(now)}`,
      task: id,
      agent,
      status: "active",
      branch: null,
      worktree: null,
      claimed_at: ts,
      released_at: null,
      completed_at: null,
    };
    writeClaim(root, claim);
    const from = task.status;
    writeTask(root, { ...task, status: "in_progress", updated_at: ts });
    appendEventUnlocked(root, {
      type: "task.claimed",
      task: id,
      claim: claim.id,
      actor: agent,
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
    const task = requireTask(root, id);
    const claim = activeClaimForTask(root, id);
    if (!claim) throw new MutationError(`task ${id} has no active claim`, "no_active_claim");
    const ts = nowIso(now);
    writeClaim(root, { ...claim, status: "released", released_at: ts });
    const from = task.status;
    writeTask(root, { ...task, status: "ready", updated_at: ts });
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
  });
}

/** Finish a task: mark it done and complete any active claim. */
export async function finishTask(
  root: string,
  id: string,
  agent: string,
  now: Date = new Date(),
): Promise<void> {
  return withLedgerLock(root, () => {
    const task = requireTask(root, id);
    if (task.status === "done") throw new MutationError(`task ${id} is already done`, "task_done");
    const ts = nowIso(now);
    const claim = activeClaimForTask(root, id);
    if (claim) {
      writeClaim(root, { ...claim, status: "completed", completed_at: ts });
    }
    const from = task.status;
    writeTask(root, { ...task, status: "done", updated_at: ts, closed_at: ts });
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
  });
}
