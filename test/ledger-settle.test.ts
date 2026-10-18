import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLedger } from "../src/core/init.ts";
import { commitLedger, ledgerStatus, settleLedger } from "../src/core/ledgerCommit.ts";
import { createTask, setTaskStatus } from "../src/core/mutate.ts";
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

function task(id: string) {
  return {
    id,
    title: id,
    status: "todo" as const,
    priority: 3,
    scope: "scope-x",
    path_hints: [],
    prompts: [],
    dependencies: [],
    acceptance: [],
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "waystation-ledger-settle-"));
  roots.push(root);
  git("init", "-q", "-b", "main");
  await initLedger(root, { project: "t" });
  writeFileSync(join(root, ".gitignore"), "*.lock\nindex.sqlite*\n.waystation/.tmp*/\n");
  writeFileSync(join(root, ".gitattributes"), ".waystation/events.jsonl merge=union\n");
  writeFileSync(
    join(root, ".waystation", "scopes", "scope-x.json"),
    JSON.stringify({ id: "scope-x", title: "X", rules: [] }),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("committed files move to pendingMerge instead of staying listed as dirty", async () => {
  await createTask(root, task("task-alice"), "alice");
  await createTask(root, task("task-bob"), "bob");
  expect((await commitLedger(root, { agent: "alice" })).ok).toBe(true);

  const status = ledgerStatus(root).data;
  expect(status?.byOwner.alice).toBeUndefined();
  expect(status?.byOwner.bob).toEqual(["tasks/task-bob.json"]);
  expect(status?.pendingMerge.map((f) => f.path)).toEqual(["tasks/task-alice.json"]);
});

test("settle lets the ledger branch merge cleanly, and only touches identical files", async () => {
  await createTask(root, task("task-alice"), "alice");
  expect((await commitLedger(root, { agent: "alice" })).ok).toBe(true);
  // Without settling, the merge would overwrite local changes.
  expect(() => git("merge", "--no-edit", "ledger/alice")).toThrow();

  const dry = await settleLedger(root, { dryRun: true });
  expect(dry.data?.settled).toContain("tasks/task-alice.json");
  expect(ledgerStatus(root).data?.pendingMerge).toHaveLength(1);

  const settled = await settleLedger(root);
  expect(settled.data?.settled).toEqual(
    expect.arrayContaining(["tasks/task-alice.json", "events.jsonl"]),
  );
  expect(git("status", "--porcelain")).toBe("");

  git("merge", "--no-edit", "ledger/alice");
  expect(validateLedger(root).ok).toBe(true);
  expect(ledgerStatus(root).data?.files).toEqual([]);
});

test("settle leaves a file alone once it differs from the branch", async () => {
  await createTask(root, task("task-alice"), "alice");
  await commitLedger(root, { agent: "alice" });
  await setTaskStatus(root, "task-alice", "ready", "alice");

  const settled = await settleLedger(root);
  expect(settled.data?.settled).not.toContain("tasks/task-alice.json");
  expect(ledgerStatus(root).data?.byOwner.alice).toEqual(["tasks/task-alice.json"]);
});

test("a file written by two actors is attributed to both", async () => {
  await createTask(root, task("task-shared"), "alice");
  await setTaskStatus(root, "task-shared", "ready", "bob");

  const status = ledgerStatus(root).data;
  expect(status?.byOwner.alice).toEqual(["tasks/task-shared.json"]);
  expect(status?.byOwner.bob).toEqual(["tasks/task-shared.json"]);

  const bob = await commitLedger(root, { agent: "bob" });
  expect(bob.ok).toBe(true);
  expect(bob.data?.files).toEqual(["tasks/task-shared.json"]);
  expect(bob.warnings.map((w) => w.code)).toContain("ledger_dependency_foreign");

  const alice = await commitLedger(root, { agent: "alice" });
  expect(alice.ok).toBe(true);
  expect(alice.data?.files).toEqual(["tasks/task-shared.json"]);
});

test("concurrent commits to the same branch serialize instead of racing", async () => {
  await createTask(root, task("task-alice"), "alice");
  const results = await Promise.all([
    commitLedger(root, { agent: "alice" }),
    commitLedger(root, { agent: "alice" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.errors[0]?.code).toBe("ledger_nothing_to_commit");
  expect(git("rev-list", "--count", "ledger/alice")).toBe("2");
});

test("init writes the union-merge rule, idempotently", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "waystation-init-attr-"));
  roots.push(fresh);
  await initLedger(fresh, { project: "t" });
  await initLedger(fresh, { project: "t", force: true });
  const text = readFileSync(join(fresh, ".gitattributes"), "utf8");
  expect(text.match(/events\.jsonl merge=union/g)).toHaveLength(1);
});

test("commit warns when events.jsonl is not set to merge=union", async () => {
  rmSync(join(root, ".gitattributes"));
  git("commit", "-qam", "drop attributes");
  await createTask(root, task("task-alice"), "alice");
  const result = await commitLedger(root, { agent: "alice" });
  expect(result.ok).toBe(true);
  expect(result.warnings.map((w) => w.code)).toContain("ledger_union_merge_missing");
});

test("the co-writer warning says which branches to merge first", async () => {
  await createTask(root, task("task-shared"), "alice");
  await setTaskStatus(root, "task-shared", "ready", "bob");
  const bob = await commitLedger(root, { agent: "bob" });
  const warning = bob.warnings.find((w) => w.code === "ledger_dependency_foreign");
  expect(warning?.message).toContain("Merge ledger/alice first, then ledger/bob");
});
