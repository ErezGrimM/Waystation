import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLedger } from "../src/core/init.ts";
import { commitLedger, ledgerStatus } from "../src/core/ledgerCommit.ts";
import { createTask } from "../src/core/mutate.ts";
import { syncLedger } from "../src/core/sync.ts";
import { validateLedger } from "../src/core/validate.ts";

const roots: string[] = [];
let root = "";

function git(...args: string[]): string {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd: root },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function task(id: string, scope: string | null = null) {
  return {
    id,
    title: id,
    status: "todo" as const,
    priority: 3,
    scope,
    path_hints: [],
    prompts: [],
    dependencies: [],
    acceptance: [],
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "waystation-ledger-commit-"));
  roots.push(root);
  git("init", "-q", "-b", "main");
  await initLedger(root, { project: "t" });
  writeFileSync(join(root, ".gitignore"), "*.lock\nindex.sqlite*\n.waystation/.tmp*/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  // alice writes a task plus the scope it references; bob writes an unrelated task.
  writeFileSync(
    join(root, ".waystation", "scopes", "scope-x.json"),
    JSON.stringify({ id: "scope-x", title: "X", rules: [] }),
  );
  await createTask(root, task("task-alice", "scope-x"), "alice");
  await createTask(root, task("task-bob"), "bob");
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("status attributes uncommitted files to the actor that wrote them", () => {
  const status = ledgerStatus(root);
  expect(status.ok).toBe(true);
  expect(status.data?.byOwner.alice).toEqual(["tasks/task-alice.json"]);
  expect(status.data?.byOwner.bob).toEqual(["tasks/task-bob.json"]);
  // The scope was written by hand, so nobody owns it.
  expect(status.data?.unattributed).toContain("scopes/scope-x.json");
});

test("commit includes only the actor's files plus referenced scope, without moving HEAD", async () => {
  const headBefore = git("rev-parse", "HEAD");
  const statusBefore = git("status", "--porcelain");

  const dry = await commitLedger(root, { agent: "alice", dryRun: true });
  expect(dry.ok).toBe(true);
  expect(dry.data?.commit).toBeNull();
  expect(git("branch", "--list", "ledger/alice")).toBe("");

  const result = await commitLedger(root, { agent: "alice" });
  expect(result.ok).toBe(true);
  expect(result.data?.branch).toBe("ledger/alice");
  expect(result.data?.files).toEqual(["scopes/scope-x.json", "tasks/task-alice.json"]);

  const committed = git("ls-tree", "-r", "--name-only", "ledger/alice").split("\n");
  expect(committed).toContain(".waystation/tasks/task-alice.json");
  expect(committed).toContain(".waystation/scopes/scope-x.json");
  expect(committed).not.toContain(".waystation/tasks/task-bob.json");

  // Only alice's events landed on the branch.
  const events = git("show", "ledger/alice:.waystation/events.jsonl");
  expect(events).toContain("task-alice");
  expect(events).not.toContain("task-bob");

  // The shared checkout is untouched.
  expect(git("rev-parse", "HEAD")).toBe(headBefore);
  expect(git("status", "--porcelain")).toBe(statusBefore);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("committing again with nothing new is reported, not duplicated", async () => {
  const again = await commitLedger(root, { agent: "alice" });
  expect(again.ok).toBe(false);
  expect(again.errors[0]?.code).toBe("ledger_nothing_to_commit");
});

test("refuses a branch that is checked out", async () => {
  const result = await commitLedger(root, { agent: "bob", branch: "main" });
  expect(result.ok).toBe(false);
  expect(result.errors[0]?.code).toBe("ledger_branch_checked_out");
});

test("the committed branch validates without scope warnings", async () => {
  expect(validateLedger(root).ok).toBe(true);
});

test("sync warns about uncommitted files written by other actors", async () => {
  // bob's task is still uncommitted in the shared tree.
  const result = await syncLedger(root, { projectRoot: root });
  expect(result.warnings.map((w) => w.code)).toContain("ledger_dirty_foreign");
});
