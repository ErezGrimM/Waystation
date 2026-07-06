import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { type CommandResult, type Diagnostic, diag, toResult } from "./result.ts";
import { ClaimRecord, MessageRecord, TaskRecord } from "./schema.ts";

/** True if a record file exists for `id` in `dir` as either JSON or YAML. */
function recordExists(dir: string, id: string): boolean {
  return existsSync(join(dir, `${id}.json`)) || existsSync(join(dir, `${id}.yaml`));
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Detect a cycle in the task dependency graph; returns the involved ids. */
function findCycle(tasks: TaskRecord[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dep)) continue; // missing target reported separately
      const cyc = visit(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  }

  for (const t of tasks) {
    const cyc = visit(t.id);
    if (cyc) return cyc;
  }
  return null;
}

/** Validate the whole ledger; returns a CommandResult (spec §18, §18.1). */
export function validateLedger(root?: string): CommandResult<null> {
  const paths = ledgerPaths(root);
  const diags: Diagnostic[] = [];
  const tasks: TaskRecord[] = [];
  const seenTaskIds = new Set<string>();

  // --- tasks: JSON validity, schema, duplicate ids ---
  for (const name of listJson(paths.tasks)) {
    const file = join(paths.tasks, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      diags.push(
        diag("invalid_json", {
          message: `${name}: invalid JSON`,
          details: { file: name, cause: (err as Error).message },
        }),
      );
      continue;
    }
    const parsed = TaskRecord.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      diags.push(
        diag("schema_invalid", {
          message: `${name}: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
          details: { file: name, path: issue?.path.join("."), issue: issue?.message },
        }),
      );
      continue;
    }
    if (seenTaskIds.has(parsed.data.id)) {
      diags.push(
        diag("duplicate_id", {
          message: `duplicate task id: ${parsed.data.id}`,
          details: { id: parsed.data.id },
        }),
      );
    }
    seenTaskIds.add(parsed.data.id);
    tasks.push(parsed.data);
  }

  // A dependency target counts as present if it exists as a JSON record OR as a
  // not-yet-migrated YAML file (transitional).
  const taskExists = (id: string) => seenTaskIds.has(id) || recordExists(paths.tasks, id);
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!taskExists(dep)) {
        diags.push(
          diag("missing_dependency", {
            message: `${t.id} depends on missing task: ${dep}`,
            details: { task: t.id, dependency: dep },
          }),
        );
      }
    }
    if (t.scope && !recordExists(join(paths.ledger, "scopes"), t.scope)) {
      diags.push(
        diag("missing_scope", {
          message: `${t.id} references missing scope: ${t.scope}`,
          details: { task: t.id, scope: t.scope },
        }),
      );
    }
    for (const p of t.prompts) {
      if (!recordExists(join(paths.ledger, "prompts"), p)) {
        diags.push(
          diag("missing_prompt", {
            message: `${t.id} references missing prompt: ${p}`,
            details: { task: t.id, prompt: p },
          }),
        );
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    diags.push(
      diag("cycle", { message: `circular dependency: ${cycle.join(" -> ")}`, details: { cycle } }),
    );
  }

  // --- claims: schema, task existence, single active claim per task ---
  const activeByTask = new Map<string, number>();
  for (const name of listJson(paths.claims)) {
    const file = join(paths.claims, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      diags.push(
        diag("invalid_json", {
          message: `${name}: invalid JSON`,
          details: { file: name, cause: (err as Error).message },
        }),
      );
      continue;
    }
    const parsed = ClaimRecord.safeParse(data);
    if (!parsed.success) {
      diags.push(
        diag("schema_invalid", {
          message: `${name}: ${parsed.error.issues[0]?.message}`,
          details: { file: name },
        }),
      );
      continue;
    }
    if (!taskExists(parsed.data.task)) {
      diags.push(
        diag("claim_orphan", {
          message: `claim ${parsed.data.id} references missing task: ${parsed.data.task}`,
          details: { claim: parsed.data.id, task: parsed.data.task },
        }),
      );
    }
    if (parsed.data.status === "active") {
      activeByTask.set(parsed.data.task, (activeByTask.get(parsed.data.task) ?? 0) + 1);
    }
  }
  for (const [taskId, count] of activeByTask) {
    if (count > 1) {
      diags.push(
        diag("multiple_active_claims", {
          message: `task ${taskId} has ${count} active claims`,
          details: { task: taskId, count },
        }),
      );
    }
  }

  // --- events: valid JSONL ---
  if (existsSync(paths.events)) {
    const lines = readFileSync(paths.events, "utf8").split("\n");
    lines.forEach((lineText, i) => {
      if (!lineText.trim()) return;
      try {
        JSON.parse(lineText);
      } catch {
        diags.push(
          diag("invalid_jsonl", {
            message: `events.jsonl line ${i + 1}: invalid JSON`,
            details: { line: i + 1 },
          }),
        );
      }
    });
  }

  // --- messages: schema, dangling in_reply_to, orphan thread ---
  const messageIds = new Set<string>();
  const messages: Array<{ id: string; thread: string; in_reply_to?: string | null }> = [];
  for (const name of listJson(paths.messages)) {
    const file = join(paths.messages, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      diags.push(
        diag("invalid_json", {
          message: `${name}: invalid JSON`,
          details: { file: name, cause: (err as Error).message },
        }),
      );
      continue;
    }
    const parsed = MessageRecord.safeParse(data);
    if (!parsed.success) {
      diags.push(
        diag("schema_invalid", {
          message: `${name}: ${parsed.error.issues[0]?.message}`,
          details: { file: name },
        }),
      );
      continue;
    }
    messageIds.add(parsed.data.id);
    messages.push({
      id: parsed.data.id,
      thread: parsed.data.thread,
      in_reply_to: parsed.data.in_reply_to,
    });
  }
  const issuesDir = join(paths.ledger, "issues");
  for (const m of messages) {
    if (m.in_reply_to && !messageIds.has(m.in_reply_to)) {
      diags.push(
        diag("dangling_reply", {
          message: `message ${m.id} replies to missing message: ${m.in_reply_to}`,
          details: { message: m.id, in_reply_to: m.in_reply_to },
        }),
      );
    }
    if (m.thread !== "project" && !taskExists(m.thread) && !recordExists(issuesDir, m.thread)) {
      diags.push(
        diag("orphan_thread", {
          message: `message ${m.id} on unknown thread: ${m.thread}`,
          details: { message: m.id, thread: m.thread },
        }),
      );
    }
  }

  return toResult(null, diags);
}
