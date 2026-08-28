import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

type HelpCase = { args: string[]; options: string[] };

function help(args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...args, "--help"],
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe("CLI help option contract", () => {
  test("lists the global root and version options", () => {
    const output = help([]);
    expect(output).toContain("--root <path>");
    expect(output).toContain("--version");
  });

  const cases: HelpCase[] = [
    { args: ["init"], options: ["--project <id>", "--force", "--json"] },
    { args: ["task", "next"], options: ["--json", "--from-index"] },
    { args: ["task", "ready"], options: ["--json"] },
    { args: ["task", "list"], options: ["--json", "--status <status>"] },
    { args: ["task", "audit"], options: ["--json"] },
    { args: ["task", "show"], options: ["--json"] },
    {
      args: ["task", "create"],
      options: [
        "--title <title>",
        "--status <status>",
        "--priority <number>",
        "--scope <id>",
        "--path-hint <path...>",
        "--prompt <id...>",
        "--depends-on <id...>",
        "--description <text>",
        "--acceptance <text...>",
        "--notes <text>",
        "--actor <actor>",
        "--json",
      ],
    },
    {
      args: ["task", "update"],
      options: [
        "--title <title>",
        "--priority <number>",
        "--scope <id>",
        "--path-hint <path...>",
        "--prompt <id...>",
        "--depends-on <id...>",
        "--description <text>",
        "--acceptance <text...>",
        "--notes <text>",
        "--actor <actor>",
        "--json",
      ],
    },
    { args: ["task", "set-status"], options: ["--actor <actor>", "--json"] },
    { args: ["task", "reopen"], options: ["--status <status>", "--actor <actor>", "--json"] },
    {
      args: ["task", "claim"],
      options: ["--agent <agent>", "--branch <branch>", "--worktree <path>", "--json"],
    },
    { args: ["task", "release"], options: ["--agent <agent>", "--json"] },
    {
      args: ["task", "finish"],
      options: ["--agent <agent>", "--commit <sha...>", "--commit-head", "--json"],
    },
    { args: ["issue", "list"], options: ["--status <status>", "--json"] },
    { args: ["issue", "show"], options: ["--json"] },
    {
      args: ["issue", "create"],
      options: [
        "--title <title>",
        "--id <id>",
        "--status <status>",
        "--severity <severity>",
        "--type <type>",
        "--priority <number>",
        "--task <id>",
        "--scope <id>",
        "--description <text>",
        "--evidence <text>",
        "--expected <text>",
        "--actual <text>",
        "--acceptance <text...>",
        "--resolution <text>",
        "--notes <text>",
        "--source <json>",
        "--json",
      ],
    },
    {
      args: ["issue", "update"],
      options: [
        "--title <title>",
        "--status <status>",
        "--severity <severity>",
        "--type <type>",
        "--priority <number>",
        "--task <id>",
        "--scope <id>",
        "--description <text>",
        "--evidence <text>",
        "--expected <text>",
        "--actual <text>",
        "--acceptance <text...>",
        "--resolution <text>",
        "--notes <text>",
        "--source <json>",
        "--actor <actor>",
        "--json",
      ],
    },
    { args: ["issue", "close"], options: ["--resolution <text>", "--actor <actor>", "--json"] },
    { args: ["brief"], options: ["--task <id>", "--budget <budget>", "--json"] },
    { args: ["validate"], options: ["--project", "--views", "--json"] },
    { args: ["reindex"], options: ["--json"] },
    { args: ["repair"], options: ["--json"] },
    { args: ["report"], options: ["--views", "--json"] },
    { args: ["sync"], options: ["--views", "--json"] },
    {
      args: ["handoff", "create"],
      options: ["--task <id>", "--from <agent>", "--to <agent>", "--summary <text>", "--json"],
    },
    { args: ["handoff", "show"], options: ["--json"] },
    { args: ["prompt", "list"], options: ["--json"] },
    { args: ["prompt", "show"], options: ["--json"] },
    {
      args: ["prompt", "render"],
      options: ["--task <id>", "--agent <agent>", "--role <role>", "--json"],
    },
    {
      args: ["message", "post"],
      options: [
        "--thread <id>",
        "--from <agent>",
        "--to <agent>",
        "--kind <kind>",
        "--body <text>",
        "--in-reply-to <id>",
        "--json",
      ],
    },
    { args: ["message", "list"], options: ["--thread <id>", "--json"] },
    { args: ["inbox"], options: ["--agent <agent>", "--since <cursor>", "--json"] },
    { args: ["git", "status"], options: ["--json"] },
    { args: ["gh", "import"], options: ["--repo <repo>", "--force", "--json"] },
    { args: ["gh", "export"], options: ["--repo <repo>", "--json"] },
    { args: ["dashboard"], options: ["--dev", "--port <port>"] },
  ];

  for (const { args, options } of cases) {
    test(`${args.join(" ")} exposes every declared option`, () => {
      const output = help(args);
      for (const option of options) expect(output).toContain(option);
    });
  }
});
