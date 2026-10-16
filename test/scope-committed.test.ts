import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLedger } from "../src/core/validate.ts";

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd },
  );
  expect(proc.exitCode).toBe(0);
}

function repoWithTaskAndScope(): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-scope-committed-"));
  roots.push(root);
  const ledger = join(root, ".waystation");
  mkdirSync(join(ledger, "tasks"), { recursive: true });
  mkdirSync(join(ledger, "scopes"), { recursive: true });
  writeFileSync(
    join(ledger, "tasks", "task-a.json"),
    JSON.stringify({
      id: "task-a",
      title: "A",
      status: "ready",
      priority: 1,
      scope: "scope-x",
      path_hints: [],
      dependencies: [],
      acceptance: [],
    }),
  );
  writeFileSync(
    join(ledger, "scopes", "scope-x.json"),
    JSON.stringify({ id: "scope-x", title: "X", rules: [] }),
  );
  git(root, "init", "-q");
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("warns when a committed task references an untracked scope record", () => {
  const root = repoWithTaskAndScope();
  git(root, "add", ".waystation/tasks");
  git(root, "commit", "-q", "-m", "task only");
  const codes = validateLedger(root).warnings.map((d) => d.code);
  expect(codes).toContain("scope_not_committed");
});

test("no warning once the scope record is committed too", () => {
  const root = repoWithTaskAndScope();
  git(root, "add", ".waystation");
  git(root, "commit", "-q", "-m", "task and scope");
  const codes = validateLedger(root).warnings.map((d) => d.code);
  expect(codes).not.toContain("scope_not_committed");
});

test("no warning when the ledger is not in a git repository", () => {
  const root = repoWithTaskAndScope();
  rmSync(join(root, ".git"), { recursive: true, force: true });
  const codes = validateLedger(root).warnings.map((d) => d.code);
  expect(codes).not.toContain("scope_not_committed");
});
