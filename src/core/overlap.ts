import { loadHandoffs } from "./handoff.ts";
import { loadTasks } from "./records.ts";
import type { ClaimRecord, TaskRecord } from "./schema.ts";
import { loadClaims } from "./store.ts";

export type OverlapKind = "same_scope" | "path";

export interface ActiveClaimOverlap {
  kind: OverlapKind;
  task: string;
  otherTask: string;
  claim: string;
  otherClaim: string;
  agent: string;
  otherAgent: string;
  scope?: string;
  path?: string;
  reason: string;
}

interface ClaimContext {
  claim: ClaimRecord;
  task: TaskRecord;
  paths: string[];
}

function normalizePathHint(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function pathsOverlap(a: string, b: string): boolean {
  const left = normalizePathHint(a);
  const right = normalizePathHint(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function contextFor(root: string): ClaimContext[] {
  const tasks = new Map(loadTasks(root).map((task) => [task.id, task]));
  const handoffPaths = new Map<string, string[]>();
  for (const handoff of loadHandoffs(root)) {
    const current = handoffPaths.get(handoff.task) ?? [];
    current.push(...handoff.changed_files);
    handoffPaths.set(handoff.task, current);
  }

  return loadClaims(root)
    .filter((claim) => claim.status === "active")
    .flatMap((claim) => {
      const task = tasks.get(claim.task);
      if (!task) return [];
      return [
        {
          claim,
          task,
          paths: [...task.path_hints, ...(handoffPaths.get(task.id) ?? [])],
        },
      ];
    });
}

function pairOverlap(a: ClaimContext, b: ClaimContext): ActiveClaimOverlap[] {
  const overlaps: ActiveClaimOverlap[] = [];
  if (a.task.scope && a.task.scope === b.task.scope) {
    overlaps.push({
      kind: "same_scope",
      task: a.task.id,
      otherTask: b.task.id,
      claim: a.claim.id,
      otherClaim: b.claim.id,
      agent: a.claim.agent,
      otherAgent: b.claim.agent,
      scope: a.task.scope,
      reason: `active claims share scope ${a.task.scope}`,
    });
  }

  const seenPaths = new Set<string>();
  for (const left of a.paths) {
    for (const right of b.paths) {
      if (!pathsOverlap(left, right)) continue;
      const path = normalizePathHint(left.length <= right.length ? left : right);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      overlaps.push({
        kind: "path",
        task: a.task.id,
        otherTask: b.task.id,
        claim: a.claim.id,
        otherClaim: b.claim.id,
        agent: a.claim.agent,
        otherAgent: b.claim.agent,
        path,
        reason: `active claims have overlapping path hints near ${path}`,
      });
    }
  }
  return overlaps;
}

export function activeClaimOverlaps(root: string): ActiveClaimOverlap[] {
  const contexts = contextFor(root);
  const overlaps: ActiveClaimOverlap[] = [];
  for (let i = 0; i < contexts.length; i++) {
    const left = contexts[i];
    if (!left) continue;
    for (let j = i + 1; j < contexts.length; j++) {
      const right = contexts[j];
      if (!right) continue;
      overlaps.push(...pairOverlap(left, right));
    }
  }
  return overlaps;
}

export function overlapsForTask(root: string, taskId: string): ActiveClaimOverlap[] {
  return activeClaimOverlaps(root).filter(
    (overlap) => overlap.task === taskId || overlap.otherTask === taskId,
  );
}
