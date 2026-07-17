import { getGitState } from "./git.ts";
import { ledgerPaths } from "./paths.ts";
import { type LoadedTask, loadTaskFiles } from "./records.ts";
import {
  type ClaimRecord,
  isCommitRef,
  type TaskRecord,
  TaskRecord as TaskSchema,
  type TaskStatus,
} from "./schema.ts";
import {
  activeClaimForTask,
  applyMutationIntentUnlocked,
  claimFile,
  mutationWrite,
  withLedgerLock,
} from "./store.ts";
import { indexById, taskReadiness } from "./tasks.ts";
import { idStamp, mutationStamp, nowIso, safeIdPart } from "./time.ts";

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
  /** Invocation worktree; never changes which ledger is locked or written. */
  caller?: string;
}

export interface FinishTaskOptions {
  commits?: string[];
  commitHead?: boolean;
}
export type TaskPatch = Partial<
  Pick<
    TaskRecord,
    | "title"
    | "priority"
    | "scope"
    | "path_hints"
    | "prompts"
    | "dependencies"
    | "description"
    | "acceptance"
    | "notes"
  >
>;
export interface CreateTaskInput
  extends Omit<TaskRecord, "created_at" | "updated_at" | "closed_at" | "commits"> {
  id: string;
}

export async function createTask(
  root: string,
  input: CreateTaskInput,
  actor = "system",
  now: Date = new Date(),
): Promise<TaskRecord> {
  return withLedgerLock(root, () => {
    const ts = nowIso(now);
    const task = TaskSchema.parse({
      ...input,
      status: input.status ?? "todo",
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      commits: [],
    });
    const file = `${ledgerPaths(root).tasks}/${task.id}.json`;
    if (loadTaskFiles(root).some((x) => x.task.id === task.id))
      throw new MutationError(`task already exists: ${task.id}`, "duplicate_id");
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-task-create-${task.id}-${mutationStamp(now)}`,
      kind: "task.create",
      writes: [mutationWrite(root, file, task)],
      events: [{ type: "task.created", task: task.id, actor, ts }],
    });
    return task;
  });
}

export async function updateTask(
  root: string,
  id: string,
  patch: TaskPatch,
  actor = "system",
  now: Date = new Date(),
): Promise<TaskRecord> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    const ts = nowIso(now);
    const updated = TaskSchema.parse({
      ...task,
      ...patch,
      id: task.id,
      status: task.status,
      created_at: task.created_at,
      closed_at: task.closed_at,
      commits: task.commits,
      updated_at: ts,
    });
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-task-update-${id}-${mutationStamp(now)}`,
      kind: "task.update",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "task.updated", task: id, actor, ts }],
    });
    return updated;
  });
}

export async function setTaskStatus(
  root: string,
  id: string,
  to: TaskStatus,
  actor = "system",
  now: Date = new Date(),
): Promise<TaskRecord> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    if (to === "in_progress" || task.status === "done" || task.status === "wont_do")
      throw new MutationError("use claim or reopen for this transition", "invalid_transition");
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      todo: ["ready", "wont_do"],
      ready: ["todo", "blocked", "wont_do"],
      in_progress: ["review"],
      blocked: ["todo", "ready", "wont_do"],
      review: ["ready", "done"],
      done: [],
      wont_do: [],
    };
    if (!allowed[task.status].includes(to))
      throw new MutationError("invalid task status transition", "invalid_transition");
    if (activeClaimForTask(root, id))
      throw new MutationError("active claim requires release or finish", "invalid_transition");
    const ts = nowIso(now);
    const updated = TaskSchema.parse({
      ...task,
      status: to,
      updated_at: ts,
      closed_at: to === "wont_do" ? ts : task.closed_at,
    });
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-task-status-${id}-${mutationStamp(now)}`,
      kind: "task.status",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "task.status_changed", task: id, from: task.status, to, actor, ts }],
    });
    return updated;
  });
}

export async function reopenTask(
  root: string,
  id: string,
  to: "todo" | "ready",
  actor = "system",
  now: Date = new Date(),
): Promise<TaskRecord> {
  return withLedgerLock(root, () => {
    const { task, file } = requireTask(root, id);
    if (task.status !== "done" && task.status !== "wont_do")
      throw new MutationError("only terminal tasks can be reopened", "invalid_transition");
    const ts = nowIso(now);
    const updated = TaskSchema.parse({ ...task, status: to, closed_at: null, updated_at: ts });
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-task-reopen-${id}-${mutationStamp(now)}`,
      kind: "task.reopen",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "task.reopened", task: id, from: task.status, to, actor, ts }],
    });
    return updated;
  });
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

function claimGitContext(
  caller: string,
  override: ClaimGitContext = {},
): Required<Omit<ClaimGitContext, "caller">> {
  const state = getGitState(caller);
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
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-task-commits-${id}-${mutationStamp(now)}`,
      kind: "task.commits_attached",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "task.commits_attached", task: id, commits: refs, actor: agent, ts }],
    });
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
    // The selected ledger may live in a different worktree. Record the caller
    // context, while the lock and records remain rooted at the selected ledger.
    const context = claimGitContext(gitContext?.caller ?? root, gitContext);
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
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-claim-${claim.id}`,
      kind: "task.claim",
      writes: [
        mutationWrite(root, claimFile(root, claim.id), claim),
        mutationWrite(root, file, { ...task, status: "in_progress", updated_at: ts }),
      ],
      events: [
        {
          type: "task.claimed",
          task: id,
          claim: claim.id,
          actor: agent,
          branch: claim.branch,
          worktree: claim.worktree,
          ts,
        },
        { type: "task.status_changed", task: id, from, to: "in_progress", actor: agent, ts },
      ],
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
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-release-${claim.id}`,
      kind: "task.release",
      writes: [
        mutationWrite(root, claimFile(root, claim.id), {
          ...claim,
          status: "released",
          released_at: ts,
        }),
        mutationWrite(root, file, { ...task, status: "ready", updated_at: ts }),
      ],
      events: [
        { type: "claim.released", task: id, claim: claim.id, actor: agent, ts },
        { type: "task.status_changed", task: id, from, to: "ready", actor: agent, ts },
      ],
    });
    // Released tasks return to `ready` (actionable) by design; claims are only
    // allowed from todo/ready, so no other prior status can be lost here.
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
    const completedTask = {
      ...taskWithCommits(task, refs),
      status: "done",
      updated_at: ts,
      closed_at: ts,
    };
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-finish-${id}-${mutationStamp(now)}`,
      kind: "task.finish",
      writes: [
        ...(claim
          ? [
              mutationWrite(root, claimFile(root, claim.id), {
                ...claim,
                status: "completed",
                completed_at: ts,
              }),
            ]
          : []),
        mutationWrite(root, file, completedTask),
      ],
      events: [
        { type: "task.status_changed", task: id, from, to: "done", actor: agent, ts },
        ...(claim
          ? [{ type: "claim.completed", task: id, claim: claim.id, actor: agent, ts }]
          : []),
        ...(refs.length
          ? [{ type: "task.commits_attached", task: id, commits: refs, actor: agent, ts }]
          : []),
      ],
    });
  });
}
