import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadTasks } from "../src/core/records.ts";
import type { CommandResult } from "../src/core/result.ts";
import { loadClaims, loadIssues } from "../src/core/store.ts";
import { createApp } from "../src/dashboard/server.ts";
import { buildServer } from "../src/mcp/server.ts";

type SurfaceName = "cli" | "mcp" | "dashboard";
type Operation =
  | "create_task"
  | "update_task"
  | "set_task_status"
  | "reopen_task"
  | "claim_task"
  | "release_task"
  | "create_issue"
  | "update_issue"
  | "close_issue";

interface Surface {
  name: SurfaceName;
  root: string;
  invoke(operation: Operation, input: Record<string, unknown>): Promise<CommandResult>;
  close(): Promise<void>;
}

const roots: string[] = [];
const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-parity-"));
  roots.push(root);
  for (const directory of [
    "tasks",
    "claims",
    "messages",
    "issues",
    "handoffs",
    "prompts",
    "scopes",
  ]) {
    mkdirSync(join(root, ".waystation", directory), { recursive: true });
  }
  writeFileSync(join(root, ".waystation", "events.jsonl"), "");
  writeFileSync(
    join(root, ".waystation", "tasks", "task-waiting.json"),
    JSON.stringify({
      id: "task-waiting",
      title: "Waiting task",
      status: "ready",
      priority: 2,
      scope: null,
      path_hints: [],
      prompts: [],
      dependencies: ["task-missing"],
      acceptance: [],
    }),
  );
  return root;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

async function createSurface(name: SurfaceName, root = fixtureRoot()): Promise<Surface> {
  if (name === "mcp") {
    const server = buildServer(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "parity-test", version: "0.0.1" });
    await client.connect(clientTransport);
    return {
      name,
      root,
      async invoke(operation, input) {
        const response = await client.callTool({ name: operation, arguments: input });
        const text = (response.content as Array<{ type: string; text: string }>)[0]!.text;
        return JSON.parse(text) as CommandResult;
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  if (name === "dashboard") {
    const app = createApp(root);
    return {
      name,
      root,
      async invoke(operation, input) {
        const [path, method] = dashboardRoute(operation, input);
        const response = await app.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        return (await response.json()) as CommandResult;
      },
      async close() {},
    };
  }

  return {
    name,
    root,
    async invoke(operation, input) {
      const args = cliArgs(operation, input);
      const process = Bun.spawnSync({
        cmd: [globalThis.process.execPath, "run", cli, ...args, "--json"],
        cwd: root,
      });
      return JSON.parse(process.stdout.toString()) as CommandResult;
    },
    async close() {},
  };
}

function dashboardRoute(
  operation: Operation,
  input: Record<string, unknown>,
): [string, "POST" | "PATCH"] {
  const id = String(input.id ?? "");
  const routes: Record<Operation, [string, "POST" | "PATCH"]> = {
    create_task: ["/api/tasks", "POST"],
    update_task: [`/api/tasks/${id}`, "PATCH"],
    set_task_status: [`/api/tasks/${id}/status`, "POST"],
    reopen_task: [`/api/tasks/${id}/reopen`, "POST"],
    claim_task: [`/api/tasks/${id}/claim`, "POST"],
    release_task: [`/api/tasks/${id}/release`, "POST"],
    create_issue: ["/api/issues", "POST"],
    update_issue: [`/api/issues/${id}`, "PATCH"],
    close_issue: [`/api/issues/${id}/close`, "POST"],
  };
  return routes[operation];
}

function cliArgs(operation: Operation, input: Record<string, unknown>): string[] {
  const id = String(input.id ?? "");
  const actor = String(input.actor ?? "parity");
  switch (operation) {
    case "create_task":
      return [
        "task",
        "create",
        id,
        "--title",
        String(input.title),
        "--status",
        String(input.status ?? "todo"),
        "--priority",
        String(input.priority ?? 3),
        "--description",
        String(input.description ?? ""),
        "--notes",
        String(input.notes ?? ""),
        "--actor",
        actor,
      ];
    case "update_task":
      return [
        "task",
        "update",
        id,
        "--title",
        String(input.title),
        "--priority",
        String(input.priority),
        "--actor",
        actor,
      ];
    case "set_task_status":
      return ["task", "set-status", id, String(input.status), "--actor", actor];
    case "reopen_task":
      return ["task", "reopen", id, "--status", String(input.status), "--actor", actor];
    case "claim_task":
      return ["task", "claim", id, "--agent", String(input.agent)];
    case "release_task":
      return ["task", "release", id, "--agent", String(input.agent)];
    case "create_issue":
      return [
        "issue",
        "create",
        "--id",
        id,
        "--title",
        String(input.title),
        "--severity",
        String(input.severity),
        "--type",
        String(input.type),
        "--description",
        String(input.description),
        "--evidence",
        String(input.evidence),
        "--expected",
        String(input.expected),
        "--actual",
        String(input.actual),
        "--notes",
        String(input.notes),
      ];
    case "update_issue":
      return [
        "issue",
        "update",
        id,
        "--status",
        String(input.status),
        "--severity",
        String(input.severity),
        "--actor",
        actor,
      ];
    case "close_issue":
      return ["issue", "close", id, "--resolution", String(input.resolution), "--actor", actor];
  }
}

async function exercise(surface: Surface) {
  const diagnostics: string[] = [];
  const createTaskInput = {
    id: "task-parity",
    title: "Parity task",
    status: "todo",
    priority: 3,
    scope: null,
    path_hints: [],
    prompts: [],
    dependencies: [],
    description: "Original description",
    acceptance: [],
    notes: "preserved note",
    actor: "parity",
  };
  expect((await surface.invoke("create_task", createTaskInput)).ok).toBe(true);
  diagnostics.push(
    (await surface.invoke("create_task", createTaskInput)).errors[0]?.code ?? "missing",
  );
  expect(
    (
      await surface.invoke("update_task", {
        id: "task-parity",
        title: "Updated parity task",
        priority: 2,
        actor: "parity",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await surface.invoke("set_task_status", {
        id: "task-parity",
        status: "ready",
        actor: "parity",
      })
    ).ok,
  ).toBe(true);
  diagnostics.push(
    (
      await surface.invoke("set_task_status", {
        id: "task-parity",
        status: "in_progress",
        actor: "parity",
      })
    ).errors[0]?.code ?? "missing",
  );
  expect(
    (
      await surface.invoke("set_task_status", {
        id: "task-parity",
        status: "wont_do",
        actor: "parity",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await surface.invoke("reopen_task", {
        id: "task-parity",
        status: "ready",
        actor: "parity",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await surface.invoke("claim_task", {
        id: "task-parity",
        agent: "parity",
      })
    ).ok,
  ).toBe(true);
  diagnostics.push(
    (
      await surface.invoke("set_task_status", {
        id: "task-parity",
        status: "review",
        actor: "parity",
      })
    ).errors[0]?.code ?? "missing",
  );
  expect(
    (
      await surface.invoke("release_task", {
        id: "task-parity",
        agent: "parity",
      })
    ).ok,
  ).toBe(true);
  diagnostics.push(
    (
      await surface.invoke("claim_task", {
        id: "task-waiting",
        agent: "parity",
      })
    ).errors[0]?.code ?? "missing",
  );

  const createIssueInput = {
    id: "issue-parity",
    title: "Parity issue",
    severity: "high",
    type: "bug",
    description: "Issue description",
    evidence: "failing test",
    expected: "Expected result",
    actual: "Actual result",
    notes: "preserved issue note",
  };
  expect((await surface.invoke("create_issue", createIssueInput)).ok).toBe(true);
  diagnostics.push(
    (await surface.invoke("create_issue", createIssueInput)).errors[0]?.code ?? "missing",
  );
  expect(
    (
      await surface.invoke("update_issue", {
        id: "issue-parity",
        status: "triaged",
        severity: "critical",
        actor: "parity",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await surface.invoke("close_issue", {
        id: "issue-parity",
        resolution: "Fixed consistently",
        actor: "parity",
      })
    ).ok,
  ).toBe(true);

  const events = readFileSync(join(surface.root, ".waystation", "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assertTimestampContract(surface.root, events);
  return {
    diagnostics,
    tasks: normalize(loadTasks(surface.root)),
    issues: normalize(loadIssues(surface.root)),
    claims: normalize(loadClaims(surface.root)),
    events: normalize(events),
  };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "ts" || key === "mutation" || key.endsWith("_at")) continue;
    if (key === "claim") {
      normalized[key] = "<claim>";
      continue;
    }
    if (key === "id" && "agent" in (value as Record<string, unknown>)) {
      normalized[key] = "<claim>";
      continue;
    }
    normalized[key] = normalize(entry);
  }
  return normalized;
}

function assertTimestampContract(root: string, events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    expect(Number.isNaN(Date.parse(String(event.ts)))).toBe(false);
  }
  const task = loadTasks(root).find((item) => item.id === "task-parity")!;
  const issue = loadIssues(root).find((item) => item.id === "issue-parity")!;
  const claim = loadClaims(root).find((item) => item.task === "task-parity")!;
  expect(events.find((event) => event.type === "task.created")?.ts).toBe(task.created_at);
  expect(events.findLast((event) => event.type === "task.status_changed")?.ts).toBe(
    task.updated_at,
  );
  expect(events.find((event) => event.type === "issue.closed")?.ts).toBe(
    issue.closed_at ?? undefined,
  );
  expect(issue.updated_at).toBe(issue.closed_at ?? undefined);
  expect(events.find((event) => event.type === "task.claimed")?.ts).toBe(claim.claimed_at);
  expect(events.find((event) => event.type === "claim.released")?.ts).toBe(
    claim.released_at ?? undefined,
  );
}

describe("lifecycle surface parity", () => {
  test("CLI, MCP, and dashboard produce equivalent canonical effects and diagnostics", async () => {
    const surfaces = await Promise.all(
      (["cli", "mcp", "dashboard"] as const).map((name) => createSurface(name)),
    );
    try {
      const results = await Promise.all(surfaces.map(exercise));
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]!.diagnostics).toEqual([
        "duplicate_id",
        "invalid_transition",
        "invalid_transition",
        "task_not_ready",
        "duplicate_id",
      ]);
    } finally {
      await Promise.all(surfaces.map((surface) => surface.close()));
    }
  });

  test("all mutation surfaces return mutation_intent_invalid for malformed recovery state", async () => {
    const surfaces = await Promise.all(
      (["cli", "mcp", "dashboard"] as const).map((name) => createSurface(name)),
    );
    try {
      const codes = await Promise.all(
        surfaces.map(async (surface) => {
          writeFileSync(join(surface.root, ".waystation", "mutation-intent.json"), "{}");
          const result = await surface.invoke("create_task", {
            id: `task-recovery-${surface.name}`,
            title: "Recovery task",
            status: "todo",
            priority: 3,
            scope: null,
            path_hints: [],
            prompts: [],
            dependencies: [],
            acceptance: [],
            actor: "parity",
          });
          return result.errors[0]?.code;
        }),
      );
      expect(codes).toEqual([
        "mutation_intent_invalid",
        "mutation_intent_invalid",
        "mutation_intent_invalid",
      ]);
    } finally {
      await Promise.all(surfaces.map((surface) => surface.close()));
    }
  });

  test("all surfaces resolve missing ledgers through ledger_not_found", async () => {
    const missing = mkdtempSync(join(tmpdir(), "waystation-parity-missing-"));
    roots.push(missing);
    const process = Bun.spawnSync({
      cmd: [
        globalThis.process.execPath,
        "run",
        cli,
        "task",
        "create",
        "task-missing-root",
        "--title",
        "Missing root",
        "--json",
      ],
      cwd: missing,
    });
    const cliCode = (JSON.parse(process.stdout.toString()) as CommandResult).errors[0]?.code;
    let mcpCode: string | undefined;
    let dashboardCode: string | undefined;
    try {
      buildServer(missing);
    } catch (error) {
      mcpCode = (error as { code?: string }).code;
    }
    try {
      createApp(missing);
    } catch (error) {
      dashboardCode = (error as { code?: string }).code;
    }
    expect([cliCode, mcpCode, dashboardCode]).toEqual([
      "ledger_not_found",
      "ledger_not_found",
      "ledger_not_found",
    ]);
  });

  test("surface layers do not import or call canonical ledger write primitives", () => {
    const files = [
      join(projectRoot, "src", "cli", "index.ts"),
      join(projectRoot, "src", "mcp", "server.ts"),
      join(projectRoot, "src", "dashboard", "server.ts"),
      ...sourceFiles(join(projectRoot, "src", "dashboard", "client", "src")),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /\b(writeJsonAtomic|appendEventUnlocked|mutationWrite|writeFileSync)\b/,
      );
    }
  });
});
