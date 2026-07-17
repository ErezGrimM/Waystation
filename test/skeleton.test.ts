import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBrief,
  parseBriefBudget,
  renderBrief,
  resolveTaskFromGitClaim,
} from "../src/core/brief.ts";
import {
  generateActiveWork,
  generateBlocked,
  generateStatus,
  generateTaskViews,
  reindex,
} from "../src/core/generate.ts";
import { exportGitHubIssues, importGitHubIssues } from "../src/core/gh.ts";
import { getGitState } from "../src/core/git.ts";
import { loadGraphData } from "../src/core/graph.ts";
import { createHandoff, getHandoff } from "../src/core/handoff.ts";
import { initLedger } from "../src/core/init.ts";
import { createIssue } from "../src/core/issue.ts";
import {
  inbox,
  loadMessages,
  PROJECT_THREAD,
  postMessage,
  threadMessages,
} from "../src/core/messages.ts";
import {
  claimTask,
  finishTask,
  MutationError,
  releaseTask,
  setTaskStatus,
} from "../src/core/mutate.ts";
import { activeClaimOverlaps } from "../src/core/overlap.ts";
import { LedgerResolutionError, resolveLedgerRoot } from "../src/core/paths.ts";
import { renderPrompt, selectPrompts, substitute } from "../src/core/prompt.ts";
import { loadTasks, RecordError } from "../src/core/records.ts";
import { CODES, diag, toResult } from "../src/core/result.ts";
import type { TaskRecord } from "../src/core/schema.ts";
import {
  activeClaimForTask,
  loadClaims,
  loadIssues,
  sweepTmpDirs,
  withLedgerLock,
} from "../src/core/store.ts";
import { indexById, nextTask, readyTasks, taskReadiness } from "../src/core/tasks.ts";
import { safeIdPart } from "../src/core/time.ts";
import { validateLedger } from "../src/core/validate.ts";
import {
  backendWarnings,
  buildLedgerIndex,
  inboxFromIndex,
  threadFromIndex,
} from "../src/index/ledgerIndex.ts";
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

describe("audit fixes", () => {
  test("a review task is not ready (awaiting review, not actionable)", () => {
    const r = { id: "task-rev", title: "R", status: "review", priority: 1, dependencies: [] };
    expect(readyTasks(loadTasks(fixtureRoot([r]))).map((t) => t.id)).toEqual([]);
  });

  test("duplicate task ids do not crash the index build", async () => {
    const root = fixtureRoot([{ ...A }]);
    writeFileSync(
      join(root, ".waystation", "tasks", "task-a-copy.json"),
      JSON.stringify({ ...A, title: "A2" }),
    );
    const res = await reindex(root); // must not throw on the PK conflict
    expect(res.ok).toBe(true);
  });

  test("safeIdPart strips path separators and traversal", () => {
    expect(safeIdPart("../../foo")).toBe("foo");
    expect(safeIdPart("a b/c")).toBe("a-b-c");
    expect(safeIdPart("")).toBe("x");
  });

  test("a path-y agent name yields a filesystem-safe message id", async () => {
    const root = fixtureRoot([D]);
    const m = await postMessage(
      root,
      { thread: "task-d", from: "../../evil", body: "x" },
      new Date("2026-07-06T10:00:00Z"),
      "sfx1",
    );
    expect(m.id.includes("/")).toBe(false);
    expect(m.id.includes("..")).toBe(false);
  });

  test("a path-y issue id is rejected before writing outside issues", async () => {
    const root = fixtureRoot([D]);
    await expect(createIssue(root, { id: "../tasks/task-d", title: "bad" })).rejects.toThrow(
      "invalid issue id",
    );
  });
});

describe("ledger root resolution", () => {
  test("uses explicit root, then WAYSTATION_ROOT, then caller discovery", () => {
    const parent = mkdtempSync(join(tmpdir(), "waystation-root-resolution-"));
    tmpRoots.push(parent);
    const discovered = join(parent, "discovered");
    const configured = join(parent, "configured");
    const nested = join(discovered, "nested", "deeper");
    mkdirSync(join(discovered, ".waystation"), { recursive: true });
    mkdirSync(join(configured, ".waystation"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(resolveLedgerRoot({ caller: nested })).toBe(discovered);
    expect(resolveLedgerRoot({ caller: nested, env: { WAYSTATION_ROOT: configured } })).toBe(
      configured,
    );
    expect(
      resolveLedgerRoot({
        caller: nested,
        explicitRoot: configured,
        env: { WAYSTATION_ROOT: discovered },
      }),
    ).toBe(configured);
  });

  test("reports ledger_not_found instead of silently using the caller directory", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-no-ledger-"));
    tmpRoots.push(root);
    expect(() => resolveLedgerRoot({ caller: root })).toThrow(LedgerResolutionError);
    try {
      resolveLedgerRoot({ caller: root });
    } catch (error) {
      expect((error as LedgerResolutionError).code).toBe("ledger_not_found");
    }
  });

  test("CLI rejects non-init commands without a ledger using ledger_not_found", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-cli-no-ledger-"));
    tmpRoots.push(root);
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const proc = Bun.spawnSync({ cmd: [process.execPath, "run", cli, "task", "next"], cwd: root });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("ledger_not_found");
  });

  test("shared-ledger claims preserve the caller worktree and permit exactly one winner", async () => {
    const ledgerRoot = fixtureRoot([{ ...D, id: "task-shared" }]);
    const caller = mkdtempSync(join(tmpdir(), "waystation-caller-worktree-"));
    tmpRoots.push(caller);
    Bun.spawnSync(["git", "init", "-q"], { cwd: caller });

    const results = await Promise.allSettled([
      claimTask(ledgerRoot, "task-shared", "first", undefined, { caller }),
      claimTask(ledgerRoot, "task-shared", "second", undefined, { caller }),
    ]);
    const claims = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimTask>>> =>
        result.status === "fulfilled",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.value.worktree?.replaceAll("\\", "/")).toBe(caller.replaceAll("\\", "/"));
    expect(loadClaims(ledgerRoot).filter((claim) => claim.status === "active")).toHaveLength(1);
  });
});

describe("mutation intent recovery", () => {
  test("replays a durable intent exactly once before the next mutation", async () => {
    const root = fixtureRoot([{ ...D, id: "task-replay" }]);
    const taskFile = join(root, ".waystation", "tasks", "task-replay.json");
    writeFileSync(
      join(root, ".waystation", "mutation-intent.json"),
      JSON.stringify({
        version: 1,
        id: "replay-once",
        kind: "test",
        writes: [
          { path: "tasks/task-replay.json", value: { ...D, id: "task-replay", status: "done" } },
        ],
        events: [{ type: "task.status_changed", task: "task-replay", to: "done" }],
      }),
    );
    await withLedgerLock(root, () => undefined);
    expect(JSON.parse(readFileSync(taskFile, "utf8")).status).toBe("done");
    expect(existsSync(join(root, ".waystation", "mutation-intent.json"))).toBe(false);
    await withLedgerLock(root, () => undefined);
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");
    expect(events.match(/"mutation":"replay-once"/g)).toHaveLength(1);
  });

  test("validation reports malformed pending mutation intent", () => {
    const root = fixtureRoot([{ ...D }]);
    writeFileSync(join(root, ".waystation", "mutation-intent.json"), "not json");
    expect(validateLedger(root).errors.map((d) => d.code)).toContain("mutation_intent_invalid");
  });

  test("same-kind mutations in one second retain distinct journal events", async () => {
    const root = fixtureRoot([{ ...D, id: "task-fast-status", status: "todo" }]);
    const now = new Date("2026-07-06T10:00:00.000Z");
    await setTaskStatus(root, "task-fast-status", "ready", "tester", now);
    await setTaskStatus(root, "task-fast-status", "wont_do", "tester", now);
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; mutation: string });
    expect(events.map((event) => event.type)).toEqual([
      "task.status_changed",
      "task.status_changed",
    ]);
    expect(new Set(events.map((event) => event.mutation)).size).toBe(2);
  });
});

describe("git state", () => {
  test("returns a coded error outside a git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-non-git-"));
    tmpRoots.push(root);
    const res = getGitState(root);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe("git_not_repository");
  });

  test("detects branch, worktree, and status in a git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-git-"));
    tmpRoots.push(root);
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    writeFileSync(join(root, "note.txt"), "hello");
    const res = getGitState(root);
    expect(res.ok).toBe(true);
    expect(res.data?.root).toBeTruthy();
    expect(res.data?.worktree).toBeTruthy();
    expect(res.data?.branch).toBeTruthy();
    expect(res.data?.status.untracked).toBe(1);
    expect(res.data?.status.files.map((f) => f.file)).toContain("note.txt");
  });

  test("preserves a leading dot in modified dotfile paths", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-git-dotfile-"));
    tmpRoots.push(root);
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    writeFileSync(join(root, ".dotfile"), "one");
    Bun.spawnSync(["git", "add", ".dotfile"], { cwd: root });
    Bun.spawnSync(
      ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: root },
    );
    writeFileSync(join(root, ".dotfile"), "two");
    const res = getGitState(root);
    expect(res.data?.status.files.map((f) => f.file)).toContain(".dotfile");
  });

  test("CLI git status returns the CommandResult envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-git-cli-"));
    tmpRoots.push(root);
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    mkdirSync(join(root, ".waystation"), { recursive: true });
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const p = Bun.spawnSync({
      cmd: [process.execPath, "run", cli, "git", "status", "--json"],
      cwd: root,
    });
    const res = JSON.parse(p.stdout.toString()) as { ok: boolean; data: { worktree: string } };
    expect(p.exitCode).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.data.worktree).toBeTruthy();
  });
});

describe("prompt", () => {
  function writePrompt(root: string, rec: Record<string, unknown>): void {
    mkdirSync(join(root, ".waystation", "prompts"), { recursive: true });
    writeFileSync(join(root, ".waystation", "prompts", `${rec.id}.json`), JSON.stringify(rec));
  }

  test("substitute replaces known vars and leaves unknown intact", () => {
    expect(substitute("hi {{agent}} on {{task_id}} / {{nope}}", { agent: "a", task_id: "t" })).toBe(
      "hi a on t / {{nope}}",
    );
  });

  test("selectPrompts matches by agent (and folds in the task's scope)", () => {
    const root = fixtureRoot([
      { id: "task-p", title: "P", status: "todo", priority: 1, dependencies: [], prompts: [] },
    ]);
    writePrompt(root, {
      id: "prompt-x",
      title: "X",
      status: "active",
      applies_to: { agents: ["coder"], roles: [], scopes: [], tasks: [] },
    });
    expect(selectPrompts(root, { agent: "coder", task: "task-p" }).map((p) => p.id)).toContain(
      "prompt-x",
    );
  });

  test("an inactive prompt is not selected", () => {
    const root = fixtureRoot([]);
    writePrompt(root, {
      id: "prompt-old",
      title: "Old",
      status: "archived",
      applies_to: { agents: [], roles: [], scopes: [], tasks: [] },
    });
    expect(selectPrompts(root, { agent: "x" }).map((p) => p.id)).not.toContain("prompt-old");
  });

  test("renderPrompt substitutes variables in instructions", () => {
    const root = fixtureRoot([]);
    writePrompt(root, {
      id: "prompt-r",
      title: "R",
      status: "active",
      instructions: "work on {{task_id}} as {{agent}}",
      applies_to: { agents: [], roles: [], scopes: [], tasks: [] },
    });
    const p = selectPrompts(root, {})[0];
    expect(p).toBeDefined();
    if (p)
      expect(renderPrompt(p, { task_id: "task-z", agent: "bob" })).toContain(
        "work on task-z as bob",
      );
  });
});

describe("handoff", () => {
  const now = new Date("2026-07-06T10:00:00Z");

  test("create writes a handoff and appends handoff.created", async () => {
    const root = fixtureRoot([D]);
    const h = await createHandoff(
      root,
      { task: "task-d", from: "coder", summary: "did part 1" },
      now,
    );
    expect(h.task).toBe("task-d");
    expect(getHandoff(root, h.id)?.summary).toBe("did part 1");
    expect(readFileSync(join(root, ".waystation", "events.jsonl"), "utf8")).toContain(
      "handoff.created",
    );
  });

  test("create throws for a missing task", async () => {
    const root = fixtureRoot([D]);
    let threw = false;
    try {
      await createHandoff(root, { task: "task-ghost", from: "x" }, now);
    } catch (e) {
      threw = e instanceof MutationError;
    }
    expect(threw).toBe(true);
  });

  test("validate flags a handoff referencing a missing task", () => {
    const root = fixtureRoot([D]);
    mkdirSync(join(root, ".waystation", "handoffs"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "handoffs", "h.json"),
      JSON.stringify({
        id: "handoff-x",
        task: "task-ghost",
        from_agent: "a",
        created_at: "2026-07-06T10:00:00Z",
      }),
    );
    expect(validateLedger(root).errors.map((d) => d.code)).toContain("handoff_orphan");
  });
});

describe("init", () => {
  test("creates a fresh ledger that validates clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-init-"));
    tmpRoots.push(root);
    const res = await initLedger(root, { project: "demo" });
    expect(res.ok).toBe(true);
    expect(res.data?.created).toBe(true);
    expect(existsSync(join(root, ".waystation", "config.json"))).toBe(true);
    expect(validateLedger(root).ok).toBe(true);
  });

  test("is a no-op on an already-initialized ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-init2-"));
    tmpRoots.push(root);
    await initLedger(root);
    const res = await initLedger(root);
    expect(res.data?.created).toBe(false);
    expect(res.warnings.map((w) => w.code)).toContain("already_initialized");
  });
});

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
    const inProg = {
      id: "task-ip",
      title: "IP",
      status: "in_progress",
      priority: 1,
      dependencies: [],
    };
    expect(readyTasks(loadTasks(fixtureRoot([inProg]))).map((t) => t.id)).toEqual([]);
  });

  test("a dependency-free todo task remains non-actionable backlog", () => {
    const todo = { id: "task-todo", title: "Todo", status: "todo", priority: 1, dependencies: [] };
    const loaded = loadTasks(fixtureRoot([todo]));
    expect(nextTask(loaded)).toBeNull();
    expect(taskReadiness(loaded[0]!, indexById(loaded))).toEqual({
      state: "not_eligible",
      reason: "status_todo",
      blockers: [],
    });
  });

  test("derived readiness covers every declared task status", () => {
    const expected = {
      todo: "not_eligible",
      ready: "actionable",
      in_progress: "not_eligible",
      blocked: "not_eligible",
      review: "not_eligible",
      done: "not_eligible",
      wont_do: "not_eligible",
    } as const;
    const loaded = loadTasks(
      fixtureRoot(
        Object.keys(expected).map((status) => ({
          id: `task-${status}`,
          title: status,
          status,
          priority: 1,
          dependencies: [],
        })),
      ),
    );
    const byId = indexById(loaded);
    for (const task of loaded) {
      expect(taskReadiness(task, byId).state).toBe(expected[task.status]);
    }
  });

  test("ready dependency states derive actionable or waiting with exact blockers", () => {
    const loaded = loadTasks(
      fixtureRoot([
        { id: "dep-done", title: "Done", status: "done", priority: 1, dependencies: [] },
        { id: "dep-declined", title: "Declined", status: "wont_do", priority: 1, dependencies: [] },
        { id: "dep-open", title: "Open", status: "ready", priority: 1, dependencies: [] },
        {
          id: "task-actionable",
          title: "Actionable",
          status: "ready",
          priority: 1,
          dependencies: ["dep-done", "dep-declined"],
        },
        {
          id: "task-waiting",
          title: "Waiting",
          status: "ready",
          priority: 1,
          dependencies: ["dep-done", "dep-open", "dep-missing"],
        },
      ]),
    );
    const byId = indexById(loaded);
    expect(taskReadiness(byId.get("task-actionable")!, byId)).toEqual({
      state: "actionable",
      reason: "declared_ready",
      blockers: [],
    });
    expect(taskReadiness(byId.get("task-waiting")!, byId)).toEqual({
      state: "waiting",
      reason: "unmet_dependencies",
      blockers: ["dep-open", "dep-missing"],
    });
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

  // H6: a wont_do dependency must satisfy readiness, not block it forever.
  test("a wont_do dependency satisfies readiness (in-memory and index agree)", async () => {
    const dep = { id: "dep-x", title: "X", status: "wont_do", priority: 1, dependencies: [] };
    const dependent = {
      id: "task-y",
      title: "Y",
      status: "ready",
      priority: 1,
      dependencies: ["dep-x"],
    };
    const root = fixtureRoot([dep, dependent]);
    const tasks = loadTasks(root);
    expect(readyTasks(tasks).map((t) => t.id)).toContain("task-y");

    const db = await buildTaskIndex(join(root, ".waystation", "index.sqlite"), tasks);
    const fromIndex = readyFromIndex(db).map((t) => t.id);
    db.close();
    expect(fromIndex).toContain("task-y");
    await claimTask(root, "task-y", "agent");
    expect(loadTasks(root).find((task) => task.id === "task-y")?.status).toBe("in_progress");
  });

  test("index and in-memory readiness agree across every status and blocker state", async () => {
    const records = [
      { id: "dep-done", title: "Done", status: "done", priority: 1, dependencies: [] },
      { id: "dep-wont", title: "Wont", status: "wont_do", priority: 1, dependencies: [] },
      { id: "dep-open", title: "Open", status: "ready", priority: 9, dependencies: [] },
      ...["todo", "in_progress", "blocked", "review"].map((status, index) => ({
        id: `task-${status}`,
        title: status,
        status,
        priority: index + 2,
        dependencies: [],
      })),
      {
        id: "task-ready-good",
        title: "Good",
        status: "ready",
        priority: 1,
        dependencies: ["dep-done", "dep-wont"],
      },
      {
        id: "task-ready-waiting",
        title: "Waiting",
        status: "ready",
        priority: 1,
        dependencies: ["dep-open", "dep-missing"],
      },
    ];
    const root = fixtureRoot(records);
    const tasks = loadTasks(root);
    const db = await buildTaskIndex(join(root, ".waystation", "index.sqlite"), tasks);
    expect(readyFromIndex(db).map((task) => task.id)).toEqual(
      readyTasks(tasks).map((task) => task.id),
    );
    db.close();
  });

  // M4: the orphan-tmp sweep removes stray *.tmp but never a real record.
  test("sweepTmpDirs removes orphan temp files and preserves records", () => {
    const root = fixtureRoot([D]); // writes task-d.json
    const tasksDir = join(root, ".waystation", "tasks");
    writeFileSync(join(tasksDir, "task-d.json.9999.1.tmp"), "orphan");
    writeFileSync(join(tasksDir, "stray.tmp"), "orphan");
    sweepTmpDirs(root);
    expect(existsSync(join(tasksDir, "task-d.json.9999.1.tmp"))).toBe(false);
    expect(existsSync(join(tasksDir, "stray.tmp"))).toBe(false);
    expect(existsSync(join(tasksDir, "task-d.json"))).toBe(true);
  });

  // H7: the single write lock must serialize concurrent claims on one task.
  test("concurrent claims on one task: exactly one wins", async () => {
    const root = fixtureRoot([{ ...D }]);
    const agents = ["a1", "a2", "a3", "a4", "a5"];
    const settled = await Promise.allSettled(agents.map((a) => claimTask(root, "task-d", a)));

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(agents.length - 1);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(MutationError);
      expect((reason as MutationError).code).toBe("task_already_claimed");
    }
    // The ledger ends with exactly one active claim on disk.
    expect(loadClaims(root).filter((c) => c.status === "active").length).toBe(1);
  });

  test("claim rejects todo and dependency-blocked ready tasks without ledger writes", async () => {
    for (const record of [
      { id: "task-todo", title: "Todo", status: "todo", priority: 1, dependencies: [] },
      {
        id: "task-waiting",
        title: "Waiting",
        status: "ready",
        priority: 1,
        dependencies: ["dep-open"],
      },
    ]) {
      const records =
        record.id === "task-waiting"
          ? [
              { id: "dep-open", title: "Open", status: "ready", priority: 2, dependencies: [] },
              record,
            ]
          : [record];
      const root = fixtureRoot(records);
      const taskFile = join(root, ".waystation", "tasks", `${record.id}.json`);
      const before = readFileSync(taskFile, "utf8");
      const events = join(root, ".waystation", "events.jsonl");

      let code = "";
      try {
        await claimTask(root, record.id, "agent");
      } catch (error) {
        code = (error as MutationError).code;
      }

      expect(code).toBe(record.id === "task-todo" ? "invalid_transition" : "task_not_ready");
      expect(readFileSync(taskFile, "utf8")).toBe(before);
      expect(loadClaims(root)).toEqual([]);
      expect(existsSync(events)).toBe(false);
    }
  });

  test("claim rechecks dependencies after an earlier selection becomes stale", async () => {
    const dependency = {
      id: "dep",
      title: "Dependency",
      status: "done",
      priority: 1,
      dependencies: [],
    };
    const target = {
      id: "target",
      title: "Target",
      status: "ready",
      priority: 1,
      dependencies: ["dep"],
    };
    const root = fixtureRoot([dependency, target]);
    expect(nextTask(loadTasks(root))?.id).toBe("target");

    writeFileSync(
      join(root, ".waystation", "tasks", "dep.json"),
      JSON.stringify({ ...dependency, status: "ready" }, null, 2),
    );

    await expect(claimTask(root, "target", "agent")).rejects.toMatchObject({
      code: "task_not_ready",
    });
    expect(loadTasks(root).find((task) => task.id === "target")?.status).toBe("ready");
    expect(loadClaims(root)).toEqual([]);
    expect(existsSync(join(root, ".waystation", "events.jsonl"))).toBe(false);
  });

  // H3: gh import/export reject a malformed/injecting repo before any network call.
  test("gh import/export reject an invalid repo name", async () => {
    const root = fixtureRoot([]);
    for (const bad of ["not-a-repo", "owner/name/../../user", "owner/name?x=1"]) {
      const imp = await importGitHubIssues(root, bad, "fake-token");
      expect(imp.ok).toBe(false);
      expect(imp.errors[0]?.code).toBe("invalid_github_repo");
      const exp = await exportGitHubIssues(root, bad, "fake-token");
      expect(exp.ok).toBe(false);
      expect(exp.errors[0]?.code).toBe("invalid_github_repo");
    }
  });

  // M7: a mutation writes back to the file the record lives in, not `${id}.json`.
  test("mutating a task in a mismatched filename does not duplicate the record", async () => {
    const root = fixtureRoot([]);
    const dir = join(root, ".waystation", "tasks");
    writeFileSync(
      join(dir, "foo.json"),
      JSON.stringify({ id: "task-x", title: "X", status: "ready", priority: 1, dependencies: [] }),
    );
    await claimTask(root, "task-x", "a");
    expect(existsSync(join(dir, "task-x.json"))).toBe(false); // no duplicate created
    expect(JSON.parse(readFileSync(join(dir, "foo.json"), "utf8")).status).toBe("in_progress");
    expect(loadTasks(root).filter((t) => t.id === "task-x").length).toBe(1);
  });

  // M8: messages sort by real instant (offset-aware), not lexically.
  test("messages order by parsed timestamp across offsets (in-memory and index)", async () => {
    const root = fixtureRoot([]);
    const mdir = join(root, ".waystation", "messages");
    mkdirSync(mdir, { recursive: true });
    // m1 is lexically smaller but a LATER instant (10:00Z); m2 is 09:00Z (earlier).
    writeFileSync(
      join(mdir, "m1.json"),
      JSON.stringify({
        id: "m1",
        thread: "project",
        from_agent: "x",
        body: "later",
        created_at: "2026-07-06T10:00:00+00:00",
      }),
    );
    writeFileSync(
      join(mdir, "m2.json"),
      JSON.stringify({
        id: "m2",
        thread: "project",
        from_agent: "x",
        body: "earlier",
        created_at: "2026-07-06T12:00:00+03:00",
      }),
    );
    expect(threadMessages(root, "project").map((m) => m.id)).toEqual(["m2", "m1"]);

    const db = await buildLedgerIndex(join(root, ".waystation", "index.sqlite"), {
      tasks: [],
      issues: [],
      claims: [],
      messages: loadMessages(root),
    });
    expect(threadFromIndex(db, "project").map((m) => m.id)).toEqual(["m2", "m1"]);
    db.close();
  });

  // M9: creating an issue never silently overwrites an existing one.
  test("createIssue rejects a colliding explicit id and preserves the original", async () => {
    const root = fixtureRoot([]);
    const first = await createIssue(root, { id: "issue-x", title: "First" });
    expect(first.id).toBe("issue-x");
    let code = "";
    try {
      await createIssue(root, { id: "issue-x", title: "Second" });
    } catch (e) {
      code = (e as MutationError).code;
    }
    expect(code).toBe("duplicate_id");
    expect(loadIssues(root).find((i) => i.id === "issue-x")?.title).toBe("First");
  });

  // M10: only todo/ready tasks are claimable; terminal tasks cannot be finished.
  test("claiming a blocked task and finishing a wont_do task are invalid transitions", async () => {
    const blocked = fixtureRoot([
      { id: "task-bl", title: "B", status: "blocked", priority: 1, dependencies: [] },
    ]);
    let claimCode = "";
    try {
      await claimTask(blocked, "task-bl", "a");
    } catch (e) {
      claimCode = (e as MutationError).code;
    }
    expect(claimCode).toBe("invalid_transition");

    const wont = fixtureRoot([
      { id: "task-wd", title: "W", status: "wont_do", priority: 1, dependencies: [] },
    ]);
    let finishCode = "";
    try {
      await finishTask(wont, "task-wd", "a");
    } catch (e) {
      finishCode = (e as MutationError).code;
    }
    expect(finishCode).toBe("invalid_transition");
  });

  // M11: validation flags an issue that points at a missing task.
  test("validate flags an issue referencing a missing task (issue_orphan)", () => {
    const root = fixtureRoot([]);
    const idir = join(root, ".waystation", "issues");
    mkdirSync(idir, { recursive: true });
    writeFileSync(
      join(idir, "issue-o.json"),
      JSON.stringify({ id: "issue-o", title: "O", status: "open", task: "task-missing" }),
    );
    const res = validateLedger(root);
    const codes = [...res.errors, ...res.warnings].map((d) => d.code);
    expect(codes).toContain("issue_orphan");
  });
});

describe("CLI: task list / show", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const root = fixtureRoot([A, B, C, D]);

  function run(args: string[]): { code: number | null; out: string; err: string } {
    const p = Bun.spawnSync({ cmd: [process.execPath, "run", cli, ...args], cwd: root });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("task ready exposes only declared-ready actionable tasks", () => {
    const r = run(["task", "ready", "--json"]);
    const result = JSON.parse(r.out) as { data: Array<{ id: string }> };
    expect(r.code).toBe(0);
    expect(result.data.map((task) => task.id)).toEqual(["task-d", "task-b"]);
    expect(result.data.some((task) => task.id === "task-c")).toBe(false);
  });

  test("list shows all tasks", () => {
    const r = run(["task", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("task-a");
    expect(r.out).toContain("task-d");
  });

  test("list --status filters (envelope)", () => {
    const r = run(["task", "list", "--status", "done", "--json"]);
    const res = JSON.parse(r.out) as { ok: boolean; data: Array<{ id: string }> };
    expect(res.ok).toBe(true);
    expect(res.data.map((t) => t.id)).toEqual(["task-a"]);
  });

  test("show by id returns the task (envelope)", () => {
    const r = run(["task", "show", "task-b", "--json"]);
    expect((JSON.parse(r.out) as { data: { id: string } }).data.id).toBe("task-b");
  });

  test("show unknown id exits non-zero", () => {
    const r = run(["task", "show", "task-nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such task");
  });

  test("brief rejects an invalid budget with a coded diagnostic", () => {
    const r = run(["brief", "--task", "task-b", "--budget", "tiny", "--json"]);
    const res = JSON.parse(r.out) as { ok: boolean; errors: Array<{ code: string }> };
    expect(r.code).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe("invalid_brief_budget");
  });

  test("finish --commit attaches commit references", () => {
    const localRoot = fixtureRoot([D]);
    Bun.spawnSync({
      cmd: [process.execPath, "run", cli, "task", "claim", "task-d", "--agent", "cli"],
      cwd: localRoot,
    });
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        cli,
        "task",
        "finish",
        "task-d",
        "--agent",
        "cli",
        "--commit",
        "abc1234",
      ],
      cwd: localRoot,
    });
    expect(r.exitCode).toBe(0);
    expect(loadTasks(localRoot).find((t) => t.id === "task-d")?.commits).toEqual(["abc1234"]);
  });
});

describe("CLI lifecycle surfaces", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

  function run(root: string, args: string[]) {
    const process = Bun.spawnSync({
      cmd: [globalThis.process.execPath, "run", cli, ...args],
      cwd: root,
    });
    return {
      code: process.exitCode,
      out: process.stdout.toString(),
      err: process.stderr.toString(),
    };
  }

  test("task create, update, set-status, and reopen support JSON and human output", () => {
    const root = fixtureRoot([]);
    const created = run(root, [
      "task",
      "create",
      "task-cli-life",
      "--title",
      "CLI lifecycle task",
      "--notes",
      "preserved note",
      "--json",
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out).data.status).toBe("todo");

    const updated = run(root, [
      "task",
      "update",
      "task-cli-life",
      "--title",
      "Updated through CLI",
      "--priority",
      "2",
      "--json",
    ]);
    const updatedBody = JSON.parse(updated.out);
    expect(updatedBody.data.title).toBe("Updated through CLI");
    expect(updatedBody.data.notes).toBe("preserved note");

    const ready = run(root, ["task", "set-status", "task-cli-life", "ready", "--json"]);
    expect(JSON.parse(ready.out).data.status).toBe("ready");

    const invalid = run(root, ["task", "set-status", "task-cli-life", "in_progress", "--json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.out).errors[0].code).toBe("invalid_transition");

    expect(run(root, ["task", "set-status", "task-cli-life", "wont_do", "--json"]).code).toBe(0);
    const reopened = run(root, ["task", "reopen", "task-cli-life", "--status", "ready", "--json"]);
    expect(JSON.parse(reopened.out).data.status).toBe("ready");

    const human = run(root, ["task", "create", "task-cli-human", "--title", "Human output"]);
    expect(human.out).toContain("created task-cli-human (todo)");
  });

  test("issue list, show, create, update, and close preserve rich context", () => {
    const root = fixtureRoot([]);
    const empty = run(root, ["issue", "list", "--json"]);
    expect(JSON.parse(empty.out).data).toEqual([]);

    const created = run(root, [
      "issue",
      "create",
      "--id",
      "issue-cli-life",
      "--title",
      "CLI issue",
      "--severity",
      "high",
      "--type",
      "bug",
      "--evidence",
      "bun test failed",
      "--expected",
      "Expected result",
      "--actual",
      "Actual result",
      "--notes",
      "preserved issue note",
      "--source",
      '{"system":"audit","id":9}',
      "--json",
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out).data.id).toBe("issue-cli-life");

    const shown = run(root, ["issue", "show", "issue-cli-life", "--json"]);
    const shownBody = JSON.parse(shown.out);
    expect(shownBody.data.expected).toBe("Expected result");
    expect(shownBody.data.source).toEqual({ system: "audit", id: 9 });

    const updated = run(root, [
      "issue",
      "update",
      "issue-cli-life",
      "--status",
      "triaged",
      "--severity",
      "critical",
      "--json",
    ]);
    const updatedBody = JSON.parse(updated.out);
    expect(updatedBody.data.status).toBe("triaged");
    expect(updatedBody.data.notes).toBe("preserved issue note");

    const closed = run(root, [
      "issue",
      "close",
      "issue-cli-life",
      "--resolution",
      "Fixed through CLI",
      "--json",
    ]);
    expect(JSON.parse(closed.out).data.status).toBe("closed");

    const listed = run(root, ["issue", "list", "--status", "closed", "--json"]);
    expect(JSON.parse(listed.out).data.map((item: { id: string }) => item.id)).toEqual([
      "issue-cli-life",
    ]);
    expect(run(root, ["issue", "show", "issue-cli-life"]).out).toContain("Fixed through CLI");
  });

  test("invalid patches and values return coded JSON diagnostics", () => {
    const root = fixtureRoot([{ ...D, id: "task-cli-invalid" }]);
    const emptyTaskPatch = run(root, ["task", "update", "task-cli-invalid", "--json"]);
    expect(emptyTaskPatch.code).toBe(1);
    expect(JSON.parse(emptyTaskPatch.out).errors[0].code).toBe("schema_invalid");

    const badPriority = run(root, [
      "task",
      "update",
      "task-cli-invalid",
      "--priority",
      "nope",
      "--json",
    ]);
    expect(JSON.parse(badPriority.out).errors[0].code).toBe("schema_invalid");

    const emptyIssuePatch = run(root, ["issue", "update", "missing", "--json"]);
    expect(JSON.parse(emptyIssuePatch.out).errors[0].code).toBe("schema_invalid");

    const missingIssue = run(root, ["issue", "show", "missing", "--json"]);
    expect(JSON.parse(missingIssue.out).errors[0].code).toBe("not_found");
  });

  test("claim conflicts and unmet dependencies keep their core diagnostic codes", () => {
    const waitingRoot = fixtureRoot([
      { ...D, id: "task-cli-waiting", dependencies: ["task-missing"] },
    ]);
    const waiting = run(waitingRoot, [
      "task",
      "claim",
      "task-cli-waiting",
      "--agent",
      "first",
      "--json",
    ]);
    expect(JSON.parse(waiting.out).errors[0].code).toBe("task_not_ready");

    const conflictRoot = fixtureRoot([{ ...D, id: "task-cli-conflict" }]);
    expect(
      run(conflictRoot, ["task", "claim", "task-cli-conflict", "--agent", "first", "--json"]).code,
    ).toBe(0);
    const conflict = run(conflictRoot, [
      "task",
      "claim",
      "task-cli-conflict",
      "--agent",
      "second",
      "--json",
    ]);
    expect(JSON.parse(conflict.out).errors[0].code).toBe("task_already_claimed");
  });

  test("validate exposes malformed recovery journals as coded JSON diagnostics", () => {
    const root = fixtureRoot([{ ...D, id: "task-cli-recovery" }]);
    writeFileSync(join(root, ".waystation", "mutation-intent.json"), "not json");
    const result = run(root, ["validate", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).errors.map((item: { code: string }) => item.code)).toContain(
      "mutation_intent_invalid",
    );
  });
});

describe("mutations: claim / release / finish", () => {
  const fixedNow = new Date("2026-07-06T10:00:00.000Z");

  test("claim moves task to in_progress, creates active claim, appends events", async () => {
    const root = fixtureRoot([D]);
    const claim = await claimTask(root, "task-d", "tester", fixedNow);
    expect(claim.status).toBe("active");
    expect(claim.branch).toBeNull();
    expect(claim.worktree).toBeNull();
    expect(loadTasks(root).find((t) => t.id === "task-d")?.status).toBe("in_progress");
    expect(activeClaimForTask(root, "task-d")?.id).toBe(claim.id);
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");
    expect(events).toContain("task.claimed");
    expect(events).toContain("task.status_changed");
  });

  test("claim records explicit branch and worktree context", async () => {
    const root = fixtureRoot([D]);
    const claim = await claimTask(root, "task-d", "tester", fixedNow, {
      branch: "codex/task-d",
      worktree: "C:/worktrees/task-d",
    });
    expect(claim.branch).toBe("codex/task-d");
    expect(claim.worktree).toBe("C:/worktrees/task-d");
    const events = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");
    expect(events).toContain("codex/task-d");
    expect(events).toContain("C:/worktrees/task-d");
  });

  test("claim derives branch and worktree context from git when available", async () => {
    const root = fixtureRoot([D]);
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    const claim = await claimTask(root, "task-d", "tester", fixedNow);
    expect(claim.branch).toBeTruthy();
    expect(claim.worktree).toBeTruthy();
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

  test("release rejects an agent that does not own the active claim", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    await expect(releaseTask(root, "task-d", "b", fixedNow)).rejects.toThrow(MutationError);
  });

  test("finish marks the task done and completes the claim", async () => {
    const root = fixtureRoot([D]);
    const claim = await claimTask(root, "task-d", "a", fixedNow);
    await finishTask(root, "task-d", "a", fixedNow);
    expect(loadTasks(root).find((t) => t.id === "task-d")?.status).toBe("done");
    expect(loadClaims(root).find((c) => c.id === claim.id)?.status).toBe("completed");
  });

  test("finish can attach commit references to the task", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    await finishTask(root, "task-d", "a", fixedNow, {
      commits: ["abc1234", "abcdef1234567890"],
    });
    expect(loadTasks(root).find((t) => t.id === "task-d")?.commits).toEqual([
      "abc1234",
      "abcdef1234567890",
    ]);
  });

  test("finish rejects invalid commit references", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    await expect(
      finishTask(root, "task-d", "a", fixedNow, { commits: ["not-a-sha"] }),
    ).rejects.toThrow(MutationError);
  });

  test("finish rejects an agent that does not own the active claim", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "a", fixedNow);
    await expect(finishTask(root, "task-d", "b", fixedNow)).rejects.toThrow(MutationError);
  });
});

describe("active claim overlap warnings", () => {
  const now = new Date("2026-07-06T10:00:00.000Z");

  async function overlapRoot(): Promise<string> {
    const root = fixtureRoot([
      {
        id: "task-left",
        title: "Left",
        status: "ready",
        priority: 1,
        scope: "scope-a",
        path_hints: ["src/core"],
        dependencies: [],
      },
      {
        id: "task-right",
        title: "Right",
        status: "ready",
        priority: 1,
        scope: "scope-a",
        path_hints: ["src/core/brief.ts"],
        dependencies: [],
      },
    ]);
    await claimTask(root, "task-left", "left-agent", now);
    await claimTask(root, "task-right", "right-agent", now);
    return root;
  }

  test("detects same-scope and path-hint overlap between active claims", async () => {
    const root = await overlapRoot();
    const overlaps = activeClaimOverlaps(root);
    expect(overlaps.map((o) => o.kind)).toContain("same_scope");
    expect(overlaps.map((o) => o.kind)).toContain("path");
    expect(overlaps.some((o) => o.path === "src/core")).toBe(true);
  });

  test("brief includes advisory coordination warnings", async () => {
    const root = await overlapRoot();
    const brief = buildBrief(root, "task-left", "large");
    expect(brief.coordinationWarnings.length).toBeGreaterThan(0);
    expect(renderBrief(brief)).toContain("Coordination warnings");
  });

  test("validate emits active_claim_overlap warnings", async () => {
    const root = await overlapRoot();
    const res = validateLedger(root);
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain("active_claim_overlap");
  });

  test("generated active work reports coordination warnings", async () => {
    const root = await overlapRoot();
    expect(generateActiveWork(root)).toContain("Coordination warnings");
    expect(generateStatus(root)).toContain("Coordination warnings");
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
    const orphan = {
      id: "task-x",
      title: "X",
      status: "todo",
      priority: 1,
      dependencies: ["task-missing"],
    };
    expect(codes(fixtureRoot([orphan]))).toContain("missing_dependency");
  });

  test("warns when a declared-ready task is waiting and reports exact blockers", () => {
    const root = fixtureRoot([
      { id: "dep-open", title: "Open", status: "ready", priority: 1, dependencies: [] },
      {
        id: "task-waiting",
        title: "Waiting",
        status: "ready",
        priority: 1,
        dependencies: ["dep-open"],
      },
    ]);
    const warning = validateLedger(root).warnings.find(
      (diagnostic) => diagnostic.code === "ready_with_unmet_dependencies",
    );
    expect(warning?.details).toEqual({ task: "task-waiting", blockers: ["dep-open"] });
  });

  test("validation does not treat wont_do dependencies or todo backlog as waiting", () => {
    const root = fixtureRoot([
      { id: "dep-wont", title: "Wont", status: "wont_do", priority: 1, dependencies: [] },
      {
        id: "task-ready",
        title: "Ready",
        status: "ready",
        priority: 1,
        dependencies: ["dep-wont"],
      },
      {
        id: "task-todo",
        title: "Todo",
        status: "todo",
        priority: 1,
        dependencies: ["task-ready"],
      },
    ]);
    expect(
      validateLedger(root).warnings.filter(
        (diagnostic) => diagnostic.code === "ready_with_unmet_dependencies",
      ),
    ).toEqual([]);
  });

  test("detects a duplicate id via two files with the same id", () => {
    const root = fixtureRoot([{ ...A }]);
    const second = join(root, ".waystation", "tasks", "task-a-copy.json");
    writeFileSync(second, JSON.stringify({ ...A, title: "A2" }));
    expect(codes(root)).toContain("duplicate_id");
  });

  test("flags a record whose filename does not match its id", () => {
    const root = fixtureRoot([{ ...A }]);
    const second = join(root, ".waystation", "tasks", "wrong-name.json");
    writeFileSync(second, JSON.stringify({ ...D, id: "task-d" }));
    expect(codes(root)).toContain("filename_mismatch");
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

  test("flags migrated ids and references that are not filesystem-safe", () => {
    const root = fixtureRoot([{ ...A }]);
    const tasksDir = join(root, ".waystation", "tasks");
    writeFileSync(
      join(tasksDir, "bad-id.json"),
      JSON.stringify({
        id: "../bad",
        title: "Bad",
        status: "ready",
        priority: 1,
        dependencies: [],
      }),
    );
    writeFileSync(
      join(tasksDir, "bad-ref.json"),
      JSON.stringify({
        id: "task-bad-ref",
        title: "Bad ref",
        status: "ready",
        priority: 1,
        dependencies: ["../bad"],
      }),
    );
    expect(codes(root)).toContain("schema_invalid");
  });

  test("flags invalid task commit references", () => {
    const root = fixtureRoot([{ ...D, commits: ["abc1234", "not-a-sha"] }]);
    expect(codes(root)).toContain("invalid_commit_ref");
  });

  const t0 = new Date("2026-07-06T10:00:00Z");

  test("flags a dangling in_reply_to", async () => {
    const root = fixtureRoot([D]);
    await postMessage(
      root,
      { thread: "task-d", from: "a", body: "x", inReplyTo: "message-nope" },
      t0,
      "d1",
    );
    expect(codes(root)).toContain("dangling_reply");
  });

  test("flags a malformed issue record", () => {
    const root = fixtureRoot([A]);
    mkdirSync(join(root, ".waystation", "issues"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "issues", "issue-bad.json"),
      JSON.stringify({ id: "issue-bad" }),
    );
    expect(codes(root)).toContain("schema_invalid");
  });

  test("flags an issue id colliding with a task id", () => {
    const root = fixtureRoot([A]); // task-a
    mkdirSync(join(root, ".waystation", "issues"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "issues", "x.json"),
      JSON.stringify({ id: "task-a", title: "X", status: "open" }),
    );
    expect(codes(root)).toContain("duplicate_id");
  });

  test("flags a message on an unknown (orphan) thread", async () => {
    const root = fixtureRoot([D]);
    await postMessage(root, { thread: "task-ghost", from: "a", body: "x" }, t0, "o1");
    expect(codes(root)).toContain("orphan_thread");
  });

  test("project channel and existing task threads are not orphan", async () => {
    const root = fixtureRoot([D]);
    await postMessage(root, { thread: "project", from: "a", body: "x" }, t0, "p1");
    await postMessage(root, { thread: "task-d", from: "a", body: "y" }, t0, "p2");
    expect(codes(root)).not.toContain("orphan_thread");
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
    const root = fixtureRoot([A, { ...B, commits: ["abc1234"] }, C, D]);
    const brief = buildBrief(root, "task-b");
    expect(brief.task.id).toBe("task-b");
    expect(brief.task.commits).toEqual(["abc1234"]);
    expect(brief.dependencies).toEqual([{ id: "task-a", status: "done" }]);
    expect(brief.blockedBy).toEqual([]); // task-a is done
    expect(renderBrief(brief)).toContain("## Commits");
  });

  test("reports blockers when a dependency is not done", () => {
    const waiting = { ...C, status: "ready" };
    const root = fixtureRoot([A, B, waiting, D]);
    const brief = buildBrief(root, "task-c");
    expect(brief.blockedBy).toEqual(["task-b"]);
    expect(brief.task.readiness).toEqual({
      state: "waiting",
      reason: "unmet_dependencies",
      blockers: ["task-b"],
    });
    expect(brief.nextAction).toContain("Waiting");
  });

  test("brief readiness treats wont_do as satisfied and todo as backlog", () => {
    const root = fixtureRoot([
      { id: "dep", title: "Declined", status: "wont_do", priority: 1, dependencies: [] },
      {
        id: "task-ready",
        title: "Ready",
        status: "ready",
        priority: 1,
        dependencies: ["dep"],
      },
      {
        id: "task-todo",
        title: "Todo",
        status: "todo",
        priority: 1,
        dependencies: ["task-ready"],
      },
    ]);
    const ready = buildBrief(root, "task-ready");
    expect(ready.blockedBy).toEqual([]);
    expect(ready.task.readiness.state).toBe("actionable");
    expect(renderBrief(ready)).toContain("readiness: actionable");

    const todo = buildBrief(root, "task-todo");
    expect(todo.blockedBy).toEqual([]);
    expect(todo.task.readiness.state).toBe("not_eligible");
    expect(todo.nextAction).toContain("backlog");
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

  test("renders enriched brief with graph data", () => {
    const root = fixtureRoot([
      {
        id: "task-graph",
        title: "Improve brief generation",
        status: "todo",
        priority: 2,
        scope: null,
        path_hints: ["src/core/brief.ts"],
        prompts: [],
        dependencies: [],
        acceptance: [],
      },
    ]);

    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
          { id: "n2", label: "readyTasks", file_type: "code", source_file: "src/core/tasks.ts" },
        ],
        edges: [{ source: "n1", target: "n2", relation: "calls" }],
        concepts: [{ id: "c1", name: "Task Management", keywords: ["task", "brief"] }],
      }),
    );

    const brief = buildBrief(root, "task-graph", "large");
    const rendered = renderBrief(brief);
    expect(rendered).toContain("## Related files");
    expect(rendered).toContain("## Concepts");
    expect(rendered).toContain("Task Management");
  });

  test("budget tiers deterministically add brief sections", async () => {
    const root = fixtureRoot([
      {
        id: "task-budget",
        title: "Improve brief generation",
        status: "ready",
        priority: 2,
        scope: "scope-core",
        path_hints: ["src/core/brief.ts"],
        prompts: ["prompt-waystation-v1"],
        dependencies: ["task-a"],
        acceptance: ["Budget tiers are deterministic."],
        description: "Improve task brief generation for agents.",
      },
      A,
    ]);
    mkdirSync(join(root, ".waystation", "scopes"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "scopes", "scope-core.json"),
      JSON.stringify({ id: "scope-core", rules: ["Keep logic in core."] }),
    );
    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
          { id: "n2", label: "readyTasks", file_type: "code", source_file: "src/core/tasks.ts" },
        ],
        edges: [{ source: "n1", target: "n2", relation: "calls" }],
        concepts: [{ id: "c1", name: "Task Management", keywords: ["task", "brief"] }],
      }),
    );
    await claimTask(root, "task-budget", "tester");

    const small = buildBrief(root, "task-budget", "small");
    const medium = buildBrief(root, "task-budget", "medium");
    const large = buildBrief(root, "task-budget", "large");
    const full = buildBrief(root, "task-budget", "full");

    expect(small.acceptance).toEqual(["Budget tiers are deterministic."]);
    expect(small.scopeRules).toEqual([]);
    expect(small.activeClaim).toBeNull();
    expect(medium.scopeRules).toEqual(["Keep logic in core."]);
    expect(medium.activeClaim?.agent).toBe("tester");
    expect(medium.relatedFiles).toEqual([]);
    expect(large.relatedFiles).toContain("src/core/brief.ts");
    expect(large.concepts).toContain("Task Management");
    expect(large.impactHints).toEqual([]);
    expect(full.impactHints?.[0]).toContain("src/core/brief.ts depends on");
  });

  test("invalid brief budget returns a coded diagnostic", () => {
    const result = parseBriefBudget("tiny");
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("invalid_brief_budget");
  });
});

describe("brief git claim resolution", () => {
  function gitFixtureRoot(records: Array<Record<string, unknown>>): string {
    const name = `waystation-test-git-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const root = join(import.meta.dirname, "..", name);
    tmpRoots.push(root);
    const tasksDir = join(root, ".waystation", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    for (const rec of records) {
      writeFileSync(join(tasksDir, `${rec.id as string}.json`), JSON.stringify(rec, null, 2));
    }
    return root;
  }

  test("resolveTaskFromGitClaim matches an active claim by branch", async () => {
    const root = gitFixtureRoot([A, D]);
    await claimTask(root, "task-d", "test-agent");
    const result = resolveTaskFromGitClaim(root);
    expect(result.ok).toBe(true);
    expect(result.data).toBe("task-d");
  });

  test("resolveTaskFromGitClaim returns no_git_claim_match when no claim exists", () => {
    const root = gitFixtureRoot([D]);
    const result = resolveTaskFromGitClaim(root);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.code)).toContain("no_git_claim_match");
  });

  test("resolveTaskFromGitClaim returns ambiguous with multiple matching claims", async () => {
    const root = gitFixtureRoot([D]);
    writeFileSync(
      join(root, ".waystation", "tasks", "task-e.json"),
      JSON.stringify({ id: "task-e", title: "E", status: "ready", priority: 1, dependencies: [] }),
    );
    await claimTask(root, "task-d", "agent-a");
    await claimTask(root, "task-e", "agent-b");
    const result = resolveTaskFromGitClaim(root);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.code)).toContain("ambiguous_git_claim");
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
    const root = fixtureRoot([B, { ...C, status: "ready" }, D]);
    const md = generateBlocked(root);
    expect(md).toContain("task-b");
    expect(md).toContain("task-c");
  });

  test("reports distinguish actionable, waiting, and todo backlog readiness", () => {
    const root = fixtureRoot([
      { id: "dep-open", title: "Open", status: "ready", priority: 9, dependencies: [] },
      { id: "dep-wont", title: "Wont", status: "wont_do", priority: 1, dependencies: [] },
      {
        id: "task-actionable",
        title: "Actionable",
        status: "ready",
        priority: 1,
        dependencies: ["dep-wont"],
      },
      {
        id: "task-waiting",
        title: "Waiting",
        status: "ready",
        priority: 1,
        dependencies: ["dep-open"],
      },
      {
        id: "task-todo",
        title: "Todo",
        status: "todo",
        priority: 1,
        dependencies: ["dep-open"],
      },
    ]);
    const status = generateStatus(root);
    expect(status).toContain("## Ready to claim\n- `task-actionable`");
    expect(status).toContain("## Waiting (blocked by dependencies)\n- `task-waiting`");
    expect(status).toContain("## Backlog (todo)\n- `task-todo`");

    const blocked = generateBlocked(root);
    expect(blocked).toContain("task-waiting");
    expect(blocked).not.toContain("task-todo");
    expect(blocked).not.toContain("task-actionable");
  });

  test("reports keep review tasks out of dependency-blocked buckets", () => {
    const review = {
      id: "task-review",
      title: "Review",
      status: "review",
      priority: 1,
      dependencies: [],
    };
    const root = fixtureRoot([review]);
    const status = generateStatus(root);
    expect(status).toContain("## Review");
    expect(status).toContain("task-review");
    expect(generateBlocked(root)).not.toContain("task-review");
  });

  test("status reports marked blocked tasks separately", () => {
    const blocked = {
      id: "task-blocked",
      title: "Blocked",
      status: "blocked",
      priority: 1,
      dependencies: [],
    };
    const status = generateStatus(fixtureRoot([blocked]));
    expect(status).toContain("## Marked blocked");
    expect(status).toContain("task-blocked");
  });

  test("generateTaskViews prunes stale view files", () => {
    const root = fixtureRoot([A]);
    const dir = join(root, ".waystation", "views", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task-gone.md"), "stale");
    generateTaskViews(root);
    expect(existsSync(join(dir, "task-gone.md"))).toBe(false);
    expect(existsSync(join(dir, "task-a.md"))).toBe(true);
  });

  test("generated task views expose derived readiness without persisting it", () => {
    const root = fixtureRoot([
      { id: "dep", title: "Dependency", status: "ready", priority: 2, dependencies: [] },
      {
        id: "task-view",
        title: "View",
        status: "ready",
        priority: 1,
        dependencies: ["dep"],
      },
    ]);
    generateTaskViews(root);
    const view = readFileSync(join(root, ".waystation", "views", "tasks", "task-view.md"), "utf8");
    expect(view).toContain("readiness: waiting");
    expect(view).toContain("readiness_blockers: dep");
    expect(
      readFileSync(join(root, ".waystation", "tasks", "task-view.json"), "utf8"),
    ).not.toContain('"readiness"');
  });

  test("generated Markdown escapes imported task and issue text", async () => {
    const task = {
      id: "task-markdown",
      title: "Fix [link](https://example.test) <script>",
      status: "ready",
      priority: 2,
      dependencies: [],
      description: "Imported **description** with <html>.",
      acceptance: ["Do not render [acceptance](https://example.test) as a link."],
    };
    const root = fixtureRoot([task]);
    await createIssue(root, {
      id: "issue-markdown",
      title: "Imported [issue](https://example.test) <b>",
      status: "open",
      severity: "high|critical",
    });

    const status = generateStatus(root);
    expect(status).toContain("Imported \\[issue\\]\\(https://example\\.test\\) \\<b\\>");
    expect(status).toContain("[high\\|critical]");

    generateTaskViews(root);
    const view = readFileSync(
      join(root, ".waystation", "views", "tasks", "task-markdown.md"),
      "utf8",
    );
    expect(view).toContain("Fix \\[link\\]\\(https://example\\.test\\) \\<script\\>");
    expect(view).toContain("Imported \\*\\*description\\*\\* with \\<html\\>\\.");
    expect(view).toContain(
      "Do not render \\[acceptance\\]\\(https://example\\.test\\) as a link\\.",
    );
  });

  test("generated task views include commit references", () => {
    const root = fixtureRoot([{ ...D, commits: ["abc1234"] }]);
    generateTaskViews(root);
    const view = readFileSync(join(root, ".waystation", "views", "tasks", "task-d.md"), "utf8");
    expect(view).toContain("commits: abc1234");
  });

  test("reindex returns a CommandResult with per-type counts", async () => {
    const root = fixtureRoot([A, D]);
    const res = await reindex(root);
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.warnings)).toBe(true);
    expect(res.data?.tasks).toBe(2);
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
    await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", body: "announce" },
      now,
      "dddd",
    );
    expect(inbox(root, "auditor").map((m) => m.body)).toContain("announce");
  });

  test("a thread broadcast reaches an agent holding an active claim", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "auditor", now);
    await postMessage(root, { thread: "task-d", from: "coder", body: "fyi" }, now, "eeee");
    expect(inbox(root, "auditor").map((m) => m.body)).toContain("fyi");
  });

  test("since cursor excludes strictly-older messages (boundary inclusive)", async () => {
    const root = fixtureRoot([D]);
    await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", body: "old" },
      new Date("2026-07-06T09:00:00Z"),
      "ffff",
    );
    const recent = await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", body: "new" },
      new Date("2026-07-06T11:00:00Z"),
      "gggg",
    );
    // Cursor at the newer message's timestamp: the older one is strictly before
    // (dropped); the boundary message itself is kept (never lost).
    expect(inbox(root, "auditor", recent.created_at).map((m) => m.body)).toEqual(["new"]);
  });
});

describe("ledger index (all record types)", () => {
  const now = new Date("2026-07-06T10:00:00Z");

  test("reindex counts all record types and rebuild is stable", async () => {
    const root = fixtureRoot([A, D]);
    mkdirSync(join(root, ".waystation", "issues"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "issues", "issue-x.json"),
      JSON.stringify({ id: "issue-x", title: "X", status: "open", severity: "low" }),
    );
    await claimTask(root, "task-d", "coder", now);
    await postMessage(root, { thread: "task-d", from: "coder", body: "hi" }, now, "zzz1");

    const c1 = await reindex(root);
    expect(c1.data).toEqual({
      tasks: 2,
      issues: 1,
      claims_total: 1,
      claims_active: 1,
      messages: 1,
    });
    const c2 = await reindex(root); // rebuild over the same file
    expect(c2.data).toEqual(c1.data);
  });

  test("backendWarnings flags only the node:sqlite fallback", () => {
    expect(backendWarnings("node:sqlite").map((d) => d.code)).toEqual(["sqlite_backend_fallback"]);
    expect(backendWarnings("bun:sqlite")).toEqual([]);
  });

  test("inboxFromIndex matches the in-memory inbox", async () => {
    const root = fixtureRoot([D]);
    await claimTask(root, "task-d", "auditor", now);
    await postMessage(root, { thread: "task-d", from: "coder", body: "fyi" }, now, "zzz2");
    await postMessage(
      root,
      { thread: PROJECT_THREAD, from: "coder", to: "auditor", kind: "question", body: "hey" },
      now,
      "zzz3",
    );
    const db = await buildLedgerIndex(join(root, ".waystation", "index.sqlite"), {
      tasks: loadTasks(root),
      issues: loadIssues(root),
      claims: loadClaims(root),
      messages: loadMessages(root),
    });
    const fromIdx = inboxFromIndex(db, "auditor")
      .map((m) => m.body)
      .sort();
    db.close();
    const inMem = inbox(root, "auditor")
      .map((m) => m.body)
      .sort();
    expect(fromIdx).toEqual(inMem);
  });
});

describe("github import/export", () => {
  test("importGitHubIssues returns no_github_token when token is empty", async () => {
    const root = fixtureRoot([D]);
    const result = await importGitHubIssues(root, "owner/repo", "");
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.code)).toContain("no_github_token");
  });

  test("importGitHubIssues returns github_api_error for invalid repo", async () => {
    const root = fixtureRoot([D]);
    const result = await importGitHubIssues(root, "owner/nonexistent-zzz", "fake-token");
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.code)).toContain("github_api_error");
  });

  test("importGitHubIssues imports valid issues and skips pull requests", async () => {
    const root = fixtureRoot([D]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Response(
        JSON.stringify([
          {
            number: 42,
            title: "GitHub bug",
            state: "open",
            body: "Steps",
            labels: [{ name: "bug" }, { name: "high" }],
          },
          {
            number: 43,
            title: "Pull request",
            state: "open",
            body: null,
            labels: [],
            pull_request: {},
          },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const result = await importGitHubIssues(root, "owner/repo", "tok");
      expect(result.ok).toBe(true);
      expect(result.data?.ids).toEqual(["gh-42"]);
      expect(loadIssues(root).find((i) => i.id === "gh-42")?.type).toBe("bug");
      expect(loadIssues(root).find((i) => i.id === "gh-42")?.severity).toBe("high");
      expect(loadIssues(root).some((i) => i.id === "gh-43")).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("importGitHubIssues rejects malformed API items before creating records", async () => {
    const root = fixtureRoot([D]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Response(JSON.stringify([{ title: "No number", state: "open", labels: [] }]), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const result = await importGitHubIssues(root, "owner/repo", "tok");
      expect(result.ok).toBe(false);
      expect(result.errors.map((d) => d.code)).toContain("github_api_error");
      expect(loadIssues(root)).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("exportGitHubIssues returns no_github_token when token is empty", async () => {
    const root = fixtureRoot([D]);
    const result = await exportGitHubIssues(root, "owner/repo", "");
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.code)).toContain("no_github_token");
  });

  test("exportGitHubIssues returns invalid_github_repo for bad repo names", async () => {
    const root = fixtureRoot([D]);
    for (const bad of ["notarepo", "../escape", "a/b/c", ""])
      expect((await exportGitHubIssues(root, bad, "tok")).ok).toBe(false);
  });

  test("exportGitHubIssues PATCHes issues with gh-NNN ids", async () => {
    const root = fixtureRoot([]);
    const issuesDir = join(root, ".waystation", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(issuesDir, "gh-42.json"),
      JSON.stringify({ id: "gh-42", title: "Bug report", status: "open" }),
    );

    const requests: { url: string; method: string; body: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await exportGitHubIssues(root, "owner/repo", "tok");
      expect(result.ok).toBe(true);
      expect(result.data?.exported).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("PATCH");
      expect(requests[0]!.url).toContain("/issues/42");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("exportGitHubIssues POSTs issues without gh- prefix (creates new)", async () => {
    const root = fixtureRoot([]);
    const issuesDir = join(root, ".waystation", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(issuesDir, "local-1.json"),
      JSON.stringify({ id: "local-1", title: "Local issue", status: "open" }),
    );

    const requests: { url: string; method: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ number: 99 }), { status: 201 });
    }) as unknown as typeof fetch;
    try {
      const result = await exportGitHubIssues(root, "owner/repo", "tok");
      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.url).toContain("/issues");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("exportGitHubIssues maps closed/done/fixed status to state: closed", async () => {
    const root = fixtureRoot([]);
    const issuesDir = join(root, ".waystation", "issues");
    mkdirSync(issuesDir, { recursive: true });
    for (const status of ["closed", "done", "fixed"]) {
      writeFileSync(
        join(issuesDir, `gh-${status}.json`),
        JSON.stringify({ id: `gh-${status}`, title: `Issue ${status}`, status }),
      );
    }

    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await exportGitHubIssues(root, "owner/repo", "tok");
      expect(result.ok).toBe(true);
      expect(result.data?.exported).toBe(3);
      for (const body of bodies) {
        expect(JSON.parse(body).state).toBe("closed");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("exportGitHubIssues includes type and severity as labels", async () => {
    const root = fixtureRoot([]);
    const issuesDir = join(root, ".waystation", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(issuesDir, "typed.json"),
      JSON.stringify({
        id: "typed",
        title: "Typed",
        status: "open",
        type: "bug",
        severity: "high",
      }),
    );

    let sentBody = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await exportGitHubIssues(root, "owner/repo", "tok");
      const payload = JSON.parse(sentBody);
      expect(payload.labels).toContain("bug");
      expect(payload.labels).toContain("high");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("graph enrichment", () => {
  test("loadGraphData returns empty graph when file is missing", () => {
    const root = fixtureRoot([D]);
    const result = loadGraphData(root);
    expect(result.ok).toBe(true);
    expect(result.data?.nodes).toEqual([]);
    expect(result.data?.edges).toEqual([]);
  });

  test("loadGraphData loads and validates graph data", () => {
    const root = fixtureRoot([D]);
    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
          { id: "n2", label: "readyTasks", file_type: "code", source_file: "src/core/tasks.ts" },
        ],
        edges: [{ source: "n1", target: "n2", relation: "calls" }],
        concepts: [{ id: "c1", name: "Task Management", keywords: ["task", "brief"] }],
      }),
    );

    const result = loadGraphData(root);
    expect(result.ok).toBe(true);
    expect(result.data?.nodes).toHaveLength(2);
    expect(result.data?.edges).toHaveLength(1);
    expect(result.data?.concepts).toHaveLength(1);
  });

  test("brief enrichment adds graph fields when graph is present", () => {
    const root = fixtureRoot([
      {
        id: "task-graph",
        title: "Improve brief generation",
        status: "todo",
        priority: 2,
        scope: null,
        path_hints: ["src/core/brief.ts"],
        prompts: [],
        dependencies: [],
        acceptance: [],
      },
    ]);

    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
          { id: "n2", label: "readyTasks", file_type: "code", source_file: "src/core/tasks.ts" },
          { id: "n3", label: "index", file_type: "code", source_file: "src/cli/index.ts" },
        ],
        edges: [
          { source: "n1", target: "n2", relation: "calls" },
          { source: "n3", target: "n1", relation: "calls" },
        ],
        concepts: [{ id: "c1", name: "Task Management", keywords: ["task", "brief"] }],
      }),
    );

    const brief = buildBrief(root, "task-graph", "large");
    expect(brief.relatedFiles).toBeDefined();
    expect(brief.relatedFiles?.length).toBeGreaterThan(0);
    expect(brief.concepts).toBeDefined();
    expect(brief.concepts?.length).toBeGreaterThan(0);
    expect(brief.impactHints).toBeDefined();
  });

  test("brief enrichment returns empty arrays when graph is missing", () => {
    const root = fixtureRoot([D]);
    const brief = buildBrief(root, "task-d");
    expect(brief.relatedFiles).toEqual([]);
    expect(brief.concepts).toEqual([]);
    expect(brief.impactHints).toEqual([]);
  });

  test("loadGraphData handles malformed JSON gracefully", () => {
    const root = fixtureRoot([D]);
    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "graph.json"), "{ invalid json }");

    const result = loadGraphData(root);
    expect(result.ok).toBe(true);
    expect(result.data?.nodes).toEqual([]);
    expect(result.data?.edges).toEqual([]);
    expect(result.data?.concepts).toEqual([]);
  });

  test("findImpactHints deduplicates when path_hints overlap", () => {
    const root = fixtureRoot([
      {
        id: "task-overlap",
        title: "Overlapping paths",
        status: "todo",
        priority: 2,
        scope: null,
        path_hints: ["src/core/brief.ts", "src/core/"],
        prompts: [],
        dependencies: [],
        acceptance: [],
      },
    ]);

    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
          { id: "n2", label: "readyTasks", file_type: "code", source_file: "src/core/tasks.ts" },
        ],
        edges: [{ source: "n1", target: "n2", relation: "calls" }],
        concepts: [],
      }),
    );

    const brief = buildBrief(root, "task-overlap");
    const uniqueHints = new Set(brief.impactHints ?? []);
    expect((brief.impactHints ?? []).length).toBe(uniqueHints.size);
  });
});
