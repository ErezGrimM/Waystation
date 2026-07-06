import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../src/core/brief.ts";
import { generateBlocked, generateStatus, reindex } from "../src/core/generate.ts";
import { inbox, PROJECT_THREAD, postMessage, threadMessages } from "../src/core/messages.ts";
import { CODES, diag, toResult } from "../src/core/result.ts";
import { claimTask, finishTask, MutationError, releaseTask } from "../src/core/mutate.ts";
import { loadTasks, RecordError } from "../src/core/records.ts";
import type { TaskRecord } from "../src/core/schema.ts";
import { activeClaimForTask, loadClaims } from "../src/core/store.ts";
import { nextTask, readyTasks } from "../src/core/tasks.ts";
import { validateLedger } from "../src/core/validate.ts";
import { buildTaskIndex, readyFromIndex } from "../src/index/taskIndex.ts";

const tmpRoots: string[] = [];

/** Build a throwaway ledger root with the given task records written as JSON. */
function fixtureRoot(records: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-test-"));
  tmpRoots.push(root);
  const tasksDir = join(root, ".waystation", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (const rec of records) {
    writeFileSync(join(tasksDir, `${rec.id as string}.json`), JSON.stringify(rec, null, 2));
  }
  return root;
}

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

const A = { id: "task-a", title: "A", status: "done", priority: 1, dependencies: [] };
const B = { id: "task-b", title: "B", status: "ready", priority: 2, dependencies: ["task-a"] };
const C = { id: "task-c", title: "C", status: "todo", priority: 1, dependencies: ["task-b"] };
const D = { id: "task-d", title: "D", status: "ready", priority: 1, dependencies: [] };

describe("loadTasks + zod", () => {
  test("loads and validates JSON task records", () => {
    const tasks = loadTasks(fixtureRoot([A, B]));
    expect(tasks.map((t) => t.id).sort()).toEqual(["task-a", "task-b"]);
  });

  test("rejects a malformed record with RecordError", () => {
    const bad = { id: "task-bad", title: "Bad", status: "not-a-status", dependencies: [] };
    expect(() => loadTasks(fixtureRoot([bad]))).toThrow(RecordError);
  });

  test("returns empty when there is no ledger", () => {
    expect(loadTasks(mkdtempSync(join(tmpdir(), "waystation-empty-")))).toEqual([]);
  });
});

describe("next / ready resolution", () => {
  const tasks = loadTasks(fixtureRoot([A, B, C, D]));

  test("next picks highest-priority actionable task (deps done)", () => {
    // D (p1, no deps) and B (p2, dep done) are actionable; C blocked by B (not done).
    expect(nextTask(tasks)?.id).toBe("task-d");
  });

  test("ready lists only actionable tasks, best-first", () => {
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["task-d", "task-b"]);
  });

  test("a task whose dependency is not done is not ready", () => {
    expect(readyTasks(tasks).some((t) => t.id === "task-c")).toBe(false);
  });

  test("an in_progress task is not ready (already being worked)", () => {
    const inProg = { id: "task-ip", title: "IP", status: "in_progress", priority: 1, dependencies: [] };
    expect(readyTasks(loadTasks(fixtureRoot([inProg]))).map((t) => t.id)).toEqual([]);
  });
});

describe("bun:sqlite index", () => {
  test("readyFromIndex matches in-memory resolution", async () => {
    const root = fixtureRoot([A, B, C, D]);
    const tasks: TaskRecord[] = loadTasks(root);
    const db = await buildTaskIndex(join(root, ".waystation", "index.sqlite"), tasks);
    const fromIndex = readyFromIndex(db).map((t) => t.id);
    db.close();
    expect(fromIndex).toEqual(readyTasks(tasks).map((t) => t.id));
  });

  test("rebuilding the index yields equivalent results", async () => {
    const root = fixtureRoot([A, B, D]);
    const tasks: TaskRecord[] = loadTasks(root);
    const path = join(root, ".waystation", "index.sqlite");
    const db1 = await buildTaskIndex(path, tasks);
    const first = readyFromIndex(db1).map((t) => t.id);
    db1.close();
    const db2 = await buildTaskIndex(path, tasks); // rebuild over the same file
    const second = readyFromIndex(db2).map((t) => t.id);
    db2.close();
    expect(second).toEqual(first);
  });
});

describe("CLI: task list / show", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const root = fixtureRoot([A, B, C, D]);

  function run(args: string[]): { code: number | null; out: string; err: string } {
    const p = Bun.spawnSync({ cmd: [process.execPath, "run", cli, ...args], cwd: root });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("list shows all tasks", () => {
    const r = run(["task", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("task-a");
    expect(r.out).toContain("task-d");
  });

  test("list --status filters", () => {
    const r = run(["task", "list", "--status", "done", "--json"]);
    expect((JSON.parse(r.out) as Array<{ id: string }>).map((t) => t.id)).toEqual(["task-a"]);
  });

  test("show by id returns the task", () => {
    const r = run(["task", "show", "task-b", "--json"]);
    expect((JSON.parse(r.out) as { id: string }).id).toBe("task-b");
  });

  test("show unknown id exits non-zero", () => {
    const r = run(["task", "show", "task-nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such task");
  });
});

describe("mutations: claim / release / finish", () => {
  const fixedNow = new Date("2026-07-06T10:00:00.000Z");

  test("claim moves task to in_progress, creates active claim, appends events", async () => {
    const root = fixtureRoot([D]);
    const claim = await claimTask(root, "task-d", "tester", fixedNow);
    expect(claim.status).toBe("active");
    expect(loadTasks(root).find((t) => t.id === "task-d")?.status).toBe("in_progress");
    expect(activeClaimForTask(root, "task-d")?.id).toBe(claim.id);
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");
    expect(events).toContain("task.claimed");
    expect(events).toContain("task.status_changed");
  });

  test("a second active claim is rejected", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    let threw = false;
    try {
      await claimTask(root, "task-d", "b", fixedNow);
    } catch (e) {
      threw = e instanceof MutationError;
    }
    expect(threw).toBe(true);
  });

  test("release returns the task to ready and clears the active claim", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    await releaseTask(root, "task-d", "a", fixedNow);
    expect(loadTasks(root).find((t) => t.id === "task-d")?.status).toBe("ready");
    expect(activeClaimForTask(root, "task-d")).toBeUndefined();
  });

  test("finish marks the task done and completes the claim", async () => {
    const root = fixtureRoot([D]);
    const claim = await claimTask(root, "task-d", "a", fixedNow);
    await finishTask(root, "task-d", "a", fixedNow);
    expect(loadTasks(root).find((t) => t.id === "task-d")?.status).toBe("done");
    expect(loadClaims(root).find((c) => c.id === claim.id)?.status).toBe("completed");
  });
});

describe("validate", () => {
  const codes = (root: string) => {
    const r = validateLedger(root);
    return [...r.errors, ...r.warnings].map((d) => d.code);
  };

  test("a clean fixture is ok with no errors", () => {
    const res = validateLedger(fixtureRoot([A, D]));
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("detects a missing dependency target", () => {
    const orphan = { id: "task-x", title: "X", status: "todo", priority: 1, dependencies: ["task-missing"] };
    expect(codes(fixtureRoot([orphan]))).toContain("missing_dependency");
  });

  test("detects a duplicate id via two files with the same id", () => {
    const root = fixtureRoot([{ ...A }]);
    const second = join(root, ".waystation", "tasks", "task-a-copy.json");
    writeFileSync(second, JSON.stringify({ ...A, title: "A2" }));
    expect(codes(root)).toContain("duplicate_id");
  });

  test("detects a circular dependency", () => {
    const p = { id: "task-p", title: "P", status: "todo", priority: 1, dependencies: ["task-q"] };
    const q = { id: "task-q", title: "Q", status: "todo", priority: 1, dependencies: ["task-p"] };
    expect(codes(fixtureRoot([p, q]))).toContain("cycle");
  });

  test("flags an invalid record schema", () => {
    const bad = { id: "task-bad", title: "Bad", status: "nope", dependencies: [] };
    expect(codes(fixtureRoot([bad]))).toContain("schema_invalid");
  });
});

describe("error envelope", () => {
  test("every diagnostic validate emits is catalogued with a boolean retryable", () => {
    const bad = { id: "task-bad", title: "Bad", status: "nope", dependencies: ["task-missing"] };
    const res = validateLedger(fixtureRoot([bad]));
    for (const d of [...res.errors, ...res.warnings]) {
      expect(d.code in CODES).toBe(true);
      expect(typeof d.retryable).toBe("boolean");
    }
  });

  test("diag() fills message, hint, and retryable from the catalog", () => {
    const d = diag("task_already_claimed", { details: { task: "task-x" } });
    expect(d.code).toBe("task_already_claimed");
    expect(d.retryable).toBe(false);
    expect(d.hint).toBeTruthy();
    expect(d.details).toEqual({ task: "task-x" });
  });

  test("toResult buckets by severity and sets ok", () => {
    const r = toResult(null, [diag("missing_scope"), diag("duplicate_id")]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((d) => d.code)).toEqual(["duplicate_id"]);
    expect(r.warnings.map((d) => d.code)).toEqual(["missing_scope"]);
  });
});

describe("brief", () => {
  test("includes the target task's goal, acceptance, and dependency statuses", () => {
    const root = fixtureRoot([A, B, C, D]);
    const brief = buildBrief(root, "task-b");
    expect(brief.task.id).toBe("task-b");
    expect(brief.dependencies).toEqual([{ id: "task-a", status: "done" }]);
    expect(brief.blockedBy).toEqual([]); // task-a is done
  });

  test("reports blockers when a dependency is not done", () => {
    const root = fixtureRoot([A, B, C, D]);
    const brief = buildBrief(root, "task-c"); // depends on task-b (ready, not done)
    expect(brief.blockedBy).toEqual(["task-b"]);
    expect(brief.nextAction).toContain("Blocked");
  });

  test("throws on an unknown task", () => {
    const root = fixtureRoot([A]);
    let threw = false;
    try {
      buildBrief(root, "task-nope");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("generate", () => {
  test("STATUS lists ready and done tasks under the right sections", () => {
    const root = fixtureRoot([A, B, D]);
    const md = generateStatus(root);
    expect(md).toContain("Ready to claim");
    expect(md).toContain("task-d");
    expect(md).toContain("Done");
    expect(md).toContain("GENERATED");
  });

  test("blocked lists tasks whose dependencies are unmet", () => {
    const root = fixtureRoot([B, C, D]); // B waits on missing task-a; C waits on task-b
    const md = generateBlocked(root);
    expect(md).toContain("task-c");
  });

  test("reindex returns the task count and creates the index file", async () => {
    const root = fixtureRoot([A, D]);
    const n = await reindex(root);
    expect(n).toBe(2);
    expect(existsSync(join(root, ".waystation", "index.sqlite"))).toBe(true);
  });
});

describe("messages / inbox", () => {
  const now = new Date("2026-07-06T10:00:00Z");

  test("post writes a message and appends message.posted", async () => {
    const root = fixtureRoot([D]);
    const m = await postMessage(root, { thread: "task-d", from: "coder", body: "hi" }, now, "aaaa");
    expect(m.id).toContain("message-task-d-coder");
    expect(threadMessages(root, "task-d").map((x) => x.id)).toEqual([m.id]);
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");
    expect(events).toContain("message.posted");
  });

  test("inbox returns direct messages and excludes the agent's own", async () => {
    const root = fixtureRoot([D]);
    await postMessage(
      root,
      { thread: "task-d", from: "coder", to: "auditor", kind: "question", body: "ok?" },
      now,
      "bbbb",
    );
    await postMessage(root, { thread: "task-d", from: "auditor", body: "mine" }, now, "cccc");
    expect(inbox(root, "auditor").map((m) => m.body)).toEqual(["ok?"]);
  });

  test("project channel broadcasts reach everyone", async () => {
    const root = fixtureRoot([D]);
    await postMessage(root, { thread: PROJECT_THREAD, from: "coder", body: "announce" }, now, "dddd");
    expect(inbox(root, "auditor").map((m) => m.body)).toContain("announce");
  });

  test("a thread broadcast reaches an agent holding an active claim", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "auditor", now);
    await postMessage(root, { thread: "task-d", from: "coder", body: "fyi" }, now, "eeee");
    expect(inbox(root, "auditor").map((m) => m.body)).toContain("fyi");
  });

  test("since cursor excludes older messages", async () => {
    const root = fixtureRoot([D]);
    const old = await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", body: "old" },
      new Date("2026-07-06T09:00:00Z"),
      "ffff",
    );
    await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", body: "new" },
      new Date("2026-07-06T11:00:00Z"),
      "gggg",
    );
    expect(inbox(root, "auditor", old.created_at).map((m) => m.body)).toEqual(["new"]);
  });
});
