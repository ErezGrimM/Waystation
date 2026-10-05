import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initLedger } from "../src/core/init.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "waystation-list-cli-"));
  roots.push(root);
  await initLedger(root);
  const tasks = join(root, ".waystation", "tasks");
  const issues = join(root, ".waystation", "issues");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(issues, { recursive: true });
  writeFileSync(
    join(tasks, "task-p4.json"),
    JSON.stringify(
      {
        id: "task-p4",
        title: "P4",
        status: "todo",
        priority: 3,
        dependencies: [],
        prompts: ["prompt-one"],
        path_hints: ["before/path"],
        acceptance: ["before acceptance"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(issues, "issue-p4.json"),
    JSON.stringify(
      { id: "issue-p4", title: "P4 issue", status: "open", acceptance: ["before"] },
      null,
      2,
    ),
  );
  return root;
}

function run(root: string, args: string[]) {
  const proc = Bun.spawnSync({ cmd: [process.execPath, "run", cli, ...args], cwd: root });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function expectRequiredValue(result: ReturnType<typeof run>, option: string) {
  const body = JSON.parse(result.out) as {
    ok: boolean;
    errors: Array<{ code: string; message: string }>;
  };
  expect(result.code).not.toBe(0);
  expect(body.ok).toBe(false);
  expect(body.errors[0]?.code).toBe("cli_option_value_required");
  expect(body.errors[0]?.message).toContain(option);
  expect(body.errors[0]?.message).toContain("requires at least one value");
}

describe("CLI list-valued options", () => {
  test("refuses an empty list before task or issue mutations", async () => {
    const root = await fixture();
    const cases = [
      [
        "task",
        "create",
        "task-new",
        "--title",
        "New",
        "--depends-on",
        "--description",
        "desc",
        "--json",
      ],
      ["task", "create", "task-new", "--title", "New", "--acceptance", "--json"],
      ["task", "create", "--acceptance", "--title", "New", "task-new", "--json"],
      ["task", "update", "task-p4", "--path-hint", "--json"],
      ["task", "update", "task-p4", "--prompt", "--json"],
      ["task", "update", "task-p4", "--depends-on", "--json"],
      ["task", "update", "task-p4", "--acceptance", "--json"],
      ["task", "finish", "task-p4", "--agent", "cli", "--commit", "--json"],
      ["issue", "create", "--title", "New issue", "--acceptance", "--json"],
      ["issue", "update", "issue-p4", "--acceptance", "--json"],
    ];
    const beforeTask = readFileSync(join(root, ".waystation", "tasks", "task-p4.json"), "utf8");
    const beforeIssue = readFileSync(join(root, ".waystation", "issues", "issue-p4.json"), "utf8");
    for (const args of cases) {
      const option = args.find(
        (arg) =>
          arg.startsWith("--") &&
          ["--depends-on", "--acceptance", "--path-hint", "--prompt", "--commit"].includes(arg),
      )!;
      expectRequiredValue(run(root, args), option);
    }
    expect(readFileSync(join(root, ".waystation", "tasks", "task-p4.json"), "utf8")).toBe(
      beforeTask,
    );
    expect(readFileSync(join(root, ".waystation", "issues", "issue-p4.json"), "utf8")).toBe(
      beforeIssue,
    );
    expect(() =>
      readFileSync(join(root, ".waystation", "tasks", "task-new.json"), "utf8"),
    ).toThrow();
  });

  test("space-separated and repeated list values accumulate", async () => {
    const root = await fixture();
    const created = run(root, [
      "task",
      "create",
      "task-new",
      "--title",
      "New",
      "--depends-on",
      "task-a",
      "task-b",
      "--depends-on",
      "task-c",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const record = JSON.parse(
      readFileSync(join(root, ".waystation", "tasks", "task-new.json"), "utf8"),
    );
    expect(record.dependencies).toEqual(["task-a", "task-b", "task-c"]);
  });

  test("task and issue update help documents list clearing", () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-list-help-"));
    roots.push(root);
    expect(run(root, ["task", "update", "--help"]).out).toContain("--clear-path-hints");
    const taskHelp = run(root, ["task", "update", "--help"]).out;
    expect(taskHelp).toContain("--clear-prompts");
    expect(taskHelp).toContain("--clear-dependencies");
    expect(taskHelp).toContain("--clear-acceptance");
    expect(run(root, ["issue", "update", "--help"]).out).toContain("--clear-acceptance");
  });

  test("explicit clear switches empty task and issue lists", async () => {
    const root = await fixture();
    const task = run(root, [
      "task",
      "update",
      "task-p4",
      "--clear-path-hints",
      "--clear-prompts",
      "--clear-dependencies",
      "--clear-acceptance",
      "--json",
    ]);
    expect(task.code).toBe(0);
    const taskRecord = JSON.parse(
      readFileSync(join(root, ".waystation", "tasks", "task-p4.json"), "utf8"),
    );
    expect(taskRecord.path_hints).toEqual([]);
    expect(taskRecord.prompts).toEqual([]);
    expect(taskRecord.dependencies).toEqual([]);
    expect(taskRecord.acceptance).toEqual([]);
    const issue = run(root, ["issue", "update", "issue-p4", "--clear-acceptance", "--json"]);
    expect(issue.code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(root, ".waystation", "issues", "issue-p4.json"), "utf8"))
        .acceptance,
    ).toEqual([]);
  });
});
