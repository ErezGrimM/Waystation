import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildServer } from "../src/mcp/server.ts";

const testRoot = join(process.cwd(), ".waystation-test-mcp");

function setupLedger() {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: testRoot });
  mkdirSync(join(testRoot, ".waystation", "tasks"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "claims"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "messages"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "issues"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "handoffs"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "prompts"), { recursive: true });
  mkdirSync(join(testRoot, ".waystation", "scopes"), { recursive: true });
  writeFileSync(join(testRoot, ".waystation", "events.jsonl"), "");

  const task = {
    id: "test-task",
    title: "Test Task",
    status: "ready",
    priority: 1,
    dependencies: [],
    prompts: [],
    path_hints: ["src/core/brief.ts"],
    acceptance: [],
    created_at: "2026-07-06T12:00:00+03:00",
    updated_at: "2026-07-06T12:00:00+03:00",
    description: "A test task for MCP integration tests.",
  };
  writeFileSync(
    join(testRoot, ".waystation", "tasks", "test-task.json"),
    JSON.stringify(task, null, 2),
  );
}

function teardownLedger() {
  rmSync(testRoot, { recursive: true, force: true });
}

describe("mcp sdk smoke (Bun)", () => {
  test("server + client round trip over an in-memory transport", async () => {
    const server = new McpServer({ name: "waystation-smoke", version: "0.0.1" });
    server.registerTool(
      "ping",
      { description: "echo back a message", inputSchema: { msg: z.string() } },
      async ({ msg }) => ({ content: [{ type: "text", text: `pong: ${msg}` }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "smoke-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");

    const res = await client.callTool({ name: "ping", arguments: { msg: "hi" } });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    expect(first?.text).toBe("pong: hi");

    await client.close();
    await server.close();
  });
});

describe("mcp server integration", () => {
  beforeAll(() => setupLedger());
  afterAll(() => teardownLedger());

  test("lists all expected tools", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("get_status");
    expect(names).toContain("get_next_task");
    expect(names).toContain("get_task");
    expect(names).toContain("get_issue");
    expect(names).toContain("get_brief");
    expect(names).toContain("render_prompt");
    expect(names).toContain("list_issues");
    expect(names).toContain("get_inbox");
    expect(names).toContain("get_git_context");
    expect(names).toContain("validate_ledger");
    expect(names).toContain("claim_task");
    expect(names).toContain("create_task");
    expect(names).toContain("update_task");
    expect(names).toContain("set_task_status");
    expect(names).toContain("reopen_task");
    expect(names).toContain("release_task");
    expect(names).toContain("finish_task");
    expect(names).toContain("add_task_commit");
    expect(names).toContain("create_handoff");
    expect(names).toContain("post_message");
    expect(names).toContain("create_issue");
    expect(names).toContain("update_issue");
    expect(names).toContain("close_issue");
    expect(names).toContain("list_prompts");

    await client.close();
    await server.close();
  });

  test("get_git_context returns git state and active claim mappings", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: "get_git_context", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.git.worktree).toBeTruthy();
    expect(Array.isArray(result.data.activeClaims)).toBe(true);
    expect(Array.isArray(result.data.overlaps)).toBe(true);

    await client.close();
    await server.close();
  });

  test("get_next_task returns the ready task", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: "get_next_task", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data.id).toBe("test-task");

    await client.close();
    await server.close();
  });

  test("get_status returns task counts", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: "get_status", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.ledgerRoot).toBe(testRoot);
    expect(result.data.total).toBe(1);
    expect(result.data.counts.ready).toBe(1);

    await client.close();
    await server.close();
  });

  test("claim_task moves task to in_progress and creates a claim", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const claimRes = await client.callTool({
      name: "claim_task",
      arguments: { id: "test-task", agent: "test-agent" },
    });
    const claimText = (claimRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const claimResult = JSON.parse(claimText);
    expect(claimResult.ok).toBe(true);
    expect(claimResult.data.task).toBe("test-task");
    expect(claimResult.data.status).toBe("active");

    const taskRes = await client.callTool({
      name: "get_task",
      arguments: { id: "test-task" },
    });
    const taskText = (taskRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const taskResult = JSON.parse(taskText);
    expect(taskResult.ok).toBe(true);
    expect(taskResult.data.status).toBe("in_progress");

    await client.close();
    await server.close();
  });

  test("get_brief returns task brief", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: "get_brief",
      arguments: { task: "test-task" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.task.id).toBe("test-task");
    expect(result.data.task.status).toBe("in_progress");
    expect(result.data.budget).toBe("medium");
    expect(result.data.activeClaim).not.toBeNull();

    await client.close();
    await server.close();
  });

  test("get_brief validates and applies budget", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const full = await client.callTool({
      name: "get_brief",
      arguments: { task: "test-task", budget: "full" },
    });
    const fullResult: any = JSON.parse(
      (full.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(fullResult.ok).toBe(true);
    expect(fullResult.data.budget).toBe("full");

    const invalid = await client.callTool({
      name: "get_brief",
      arguments: { task: "test-task", budget: "tiny" },
    });
    const invalidResult: any = JSON.parse(
      (invalid.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.errors[0].code).toBe("invalid_brief_budget");

    await client.close();
    await server.close();
  });

  test("get_brief returns enriched brief with graph data", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const graphDir = join(testRoot, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "n1", label: "buildBrief", file_type: "code", source_file: "src/core/brief.ts" },
        ],
        edges: [],
        concepts: [{ id: "c1", name: "Task Management", keywords: ["task", "brief"] }],
      }),
    );

    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: "get_brief",
      arguments: { task: "test-task", budget: "large" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.budget).toBe("large");
    expect(result.data.relatedFiles.length).toBeGreaterThan(0);
    expect(result.data.concepts.length).toBeGreaterThan(0);
    expect(result.data.impactHints).toBeDefined();

    await client.close();
    await server.close();
  });

  test("validate_ledger returns ok", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: "validate_ledger", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);

    await client.close();
    await server.close();
  });

  test("release_task releases claim and moves task back to ready", async () => {
    const server = buildServer(testRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const relRes = await client.callTool({
      name: "release_task",
      arguments: { id: "test-task", agent: "test-agent" },
    });
    const relText = (relRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const relResult = JSON.parse(relText);
    expect(relResult.ok).toBe(true);

    const taskRes = await client.callTool({
      name: "get_task",
      arguments: { id: "test-task" },
    });
    const taskText = (taskRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const taskResult = JSON.parse(taskText);
    expect(taskResult.data.status).toBe("ready");

    await client.close();
    await server.close();
  });
});

describe("mcp lifecycle surfaces", () => {
  const root = join(process.cwd(), ".waystation-test-mcp-lifecycle");

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
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
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("tools expose the selected root and cover task and issue lifecycle results", async () => {
    const server = buildServer(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "lifecycle-test", version: "0.0.1" });
    await client.connect(clientTransport);

    expect(client.getInstructions()).toContain(root);

    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      const text = (response.content as Array<{ type: string; text: string }>)[0]!.text;
      return JSON.parse(text) as any;
    };

    const createdTask = await call("create_task", {
      id: "mcp-lifecycle-task",
      title: "MCP lifecycle task",
      status: "todo",
      priority: 2,
      description: "Original description",
      notes: "preserved note",
      actor: "mcp-test",
    });
    expect(createdTask.ok).toBe(true);
    expect(createdTask.data.status).toBe("todo");

    const duplicateTask = await call("create_task", {
      id: "mcp-lifecycle-task",
      title: "Duplicate",
    });
    expect(duplicateTask.ok).toBe(false);
    expect(duplicateTask.errors[0].code).toBe("duplicate_id");

    const updatedTask = await call("update_task", {
      id: "mcp-lifecycle-task",
      title: "Updated through MCP",
      actor: "mcp-test",
    });
    expect(updatedTask.ok).toBe(true);
    expect(updatedTask.data.title).toBe("Updated through MCP");
    expect(updatedTask.data.notes).toBe("preserved note");

    const missingTask = await call("update_task", {
      id: "missing-task",
      title: "Missing",
    });
    expect(missingTask.ok).toBe(false);
    expect(missingTask.errors[0].code).toBe("no_such_task");

    const readyTask = await call("set_task_status", {
      id: "mcp-lifecycle-task",
      status: "ready",
      actor: "mcp-test",
    });
    expect(readyTask.data.status).toBe("ready");

    const invalidStatus = await call("set_task_status", {
      id: "mcp-lifecycle-task",
      status: "in_progress",
      actor: "mcp-test",
    });
    expect(invalidStatus.ok).toBe(false);
    expect(invalidStatus.errors[0].code).toBe("invalid_transition");

    const terminalTask = await call("set_task_status", {
      id: "mcp-lifecycle-task",
      status: "wont_do",
      actor: "mcp-test",
    });
    expect(terminalTask.data.status).toBe("wont_do");

    const reopenedTask = await call("reopen_task", {
      id: "mcp-lifecycle-task",
      status: "todo",
      actor: "mcp-test",
    });
    expect(reopenedTask.data.status).toBe("todo");

    const invalidReopen = await call("reopen_task", {
      id: "mcp-lifecycle-task",
      status: "ready",
      actor: "mcp-test",
    });
    expect(invalidReopen.ok).toBe(false);
    expect(invalidReopen.errors[0].code).toBe("invalid_transition");

    const listedEmpty = await call("list_issues", {});
    expect(listedEmpty.data).toEqual([]);

    const createdIssue = await call("create_issue", {
      id: "mcp-rich-issue",
      title: "Rich MCP issue",
      severity: "high",
      type: "bug",
      description: "Context description",
      evidence: "bun test failed",
      expected: "Expected result",
      actual: "Actual result",
      acceptance: ["Regression fixed"],
      notes: "preserved issue note",
      source: { system: "audit", id: 7 },
    });
    expect(createdIssue.ok).toBe(true);

    const duplicateIssue = await call("create_issue", {
      id: "mcp-rich-issue",
      title: "Duplicate issue",
    });
    expect(duplicateIssue.ok).toBe(false);
    expect(duplicateIssue.errors[0].code).toBe("duplicate_id");

    const shownIssue = await call("get_issue", { id: "mcp-rich-issue" });
    expect(shownIssue.ok).toBe(true);
    expect(shownIssue.data.expected).toBe("Expected result");
    expect(shownIssue.data.source).toEqual({ system: "audit", id: 7 });

    const missingIssue = await call("get_issue", { id: "missing-issue" });
    expect(missingIssue.ok).toBe(false);
    expect(missingIssue.errors[0].code).toBe("not_found");

    const updatedIssue = await call("update_issue", {
      id: "mcp-rich-issue",
      status: "triaged",
      severity: "critical",
      actor: "mcp-test",
    });
    expect(updatedIssue.data.status).toBe("triaged");
    expect(updatedIssue.data.severity).toBe("critical");
    expect(updatedIssue.data.notes).toBe("preserved issue note");

    const missingUpdate = await call("update_issue", {
      id: "missing-issue",
      status: "triaged",
    });
    expect(missingUpdate.ok).toBe(false);
    expect(missingUpdate.errors[0].code).toBe("not_found");

    const closedIssue = await call("close_issue", {
      id: "mcp-rich-issue",
      resolution: "Fixed through MCP",
      actor: "mcp-test",
    });
    expect(closedIssue.data.status).toBe("closed");
    expect(closedIssue.data.resolution).toBe("Fixed through MCP");

    const missingClose = await call("close_issue", {
      id: "missing-issue",
      resolution: "Nothing to close",
    });
    expect(missingClose.ok).toBe(false);
    expect(missingClose.errors[0].code).toBe("not_found");

    const listedIssues = await call("list_issues", {});
    expect(listedIssues.data.map((issue: { id: string }) => issue.id)).toContain("mcp-rich-issue");

    await client.close();
    await server.close();
  });
});

describe("mcp tools: remaining coverage (M13)", () => {
  const root = join(process.cwd(), ".waystation-test-mcp-m13");

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    for (const d of ["tasks", "claims", "messages", "issues", "handoffs", "prompts", "scopes"]) {
      mkdirSync(join(root, ".waystation", d), { recursive: true });
    }
    writeFileSync(join(root, ".waystation", "events.jsonl"), "");
    writeFileSync(
      join(root, ".waystation", "tasks", "ready-task.json"),
      JSON.stringify({
        id: "ready-task",
        title: "Ready Task",
        status: "ready",
        priority: 2,
        dependencies: [],
        prompts: ["test-prompt"],
        path_hints: ["src/core/"],
        acceptance: ["works correctly"],
        description: "A task for testing MCP tools.",
        created_at: "2026-07-08T10:00:00+03:00",
        updated_at: "2026-07-08T10:00:00+03:00",
      }),
    );
    writeFileSync(
      join(root, ".waystation", "prompts", "test-prompt.json"),
      JSON.stringify({
        id: "test-prompt",
        title: "Test Prompt",
        version: 1,
        status: "active",
        applies_to: { agents: [], roles: [], scopes: [], tasks: [] },
        priority: 50,
        instructions: "You are testing agent {{agent}} on task {{task_id}}.",
        must_do: [],
        must_not: [],
      }),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("list_prompts returns all prompt records", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({ name: "list_prompts", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("test-prompt");

    await client.close();
    await server.close();
  });

  test("render_prompt returns rendered prompt for a task/agent", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "render_prompt",
      arguments: { task: "ready-task", agent: "coder" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.prompts).toContain("test-prompt");
    expect(result.data.rendered).toContain("coder");
    expect(result.data.rendered).toContain("ready-task");

    await client.close();
    await server.close();
  });

  test("render_prompt returns error for unknown task", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "render_prompt",
      arguments: { task: "no-such", agent: "coder" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("no_such_task");

    await client.close();
    await server.close();
  });

  test("list_issues returns empty when no issues exist", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({ name: "list_issues", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(0);

    await client.close();
    await server.close();
  });

  test("create_issue creates an issue and it appears in list_issues", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const createRes = await client.callTool({
      name: "create_issue",
      arguments: { title: "Test Bug", severity: "high", type: "bug" },
    });
    const createText = (createRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const created: any = JSON.parse(createText);
    expect(created.ok).toBe(true);
    expect(created.data.title).toBe("Test Bug");
    expect(created.data.severity).toBe("high");
    expect(created.data.type).toBe("bug");
    expect(created.data.id).toMatch(/^issue-/);

    const listRes = await client.callTool({ name: "list_issues", arguments: {} });
    const listText = (listRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const listed: any = JSON.parse(listText);
    expect(listed.data.length).toBeGreaterThanOrEqual(1);
    expect(listed.data.some((i: any) => i.id === created.data.id)).toBe(true);

    await client.close();
    await server.close();
  });

  test("create_issue rejects duplicate id", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "create_issue",
      arguments: { id: "dup-issue", title: "First" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);

    const res2 = await client.callTool({
      name: "create_issue",
      arguments: { id: "dup-issue", title: "Second" },
    });
    const text2 = (res2.content as Array<{ type: string; text: string }>)[0]!.text;
    const result2: any = JSON.parse(text2);
    expect(result2.ok).toBe(false);
    expect(result2.errors[0].code).toBe("duplicate_id");

    await client.close();
    await server.close();
  });

  test("add_task_commit attaches commit references", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const addRes = await client.callTool({
      name: "add_task_commit",
      arguments: { id: "ready-task", commits: ["abc1234"], agent: "mcp-test" },
    });
    const addText = (addRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const added: any = JSON.parse(addText);
    expect(added.ok).toBe(true);
    expect(added.data.commits).toContain("abc1234");

    await client.close();
    await server.close();
  });

  test("post_message creates a message on a thread", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "post_message",
      arguments: {
        thread: "project",
        from: "agent-a",
        body: "Hello from the test",
        kind: "note",
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.thread).toBe("project");
    expect(result.data.from_agent).toBe("agent-a");
    expect(result.data.body).toBe("Hello from the test");
    expect(result.data.kind).toBe("note");

    await client.close();
    await server.close();
  });

  test("post_message creates a message on a task thread", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "post_message",
      arguments: {
        thread: "ready-task",
        from: "agent-b",
        body: "Working on this",
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.thread).toBe("ready-task");

    await client.close();
    await server.close();
  });

  test("get_inbox returns messages for an agent", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    // Post a direct message to agent-c
    await client.callTool({
      name: "post_message",
      arguments: { thread: "project", from: "agent-x", to: "agent-c", body: "For you" },
    });

    const res = await client.callTool({
      name: "get_inbox",
      arguments: { agent: "agent-c" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result.data.some((m: any) => m.body === "For you")).toBe(true);

    await client.close();
    await server.close();
  });

  test("get_inbox excludes own messages", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    // Post a message FROM agent-d
    await client.callTool({
      name: "post_message",
      arguments: { thread: "project", from: "agent-d", body: "My own message" },
    });

    // Inbox for agent-d should NOT include its own message
    const res = await client.callTool({
      name: "get_inbox",
      arguments: { agent: "agent-d" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.every((m: any) => m.from_agent !== "agent-d")).toBe(true);

    await client.close();
    await server.close();
  });

  test("finish_task marks task done and completes claim", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    // Claim first
    await client.callTool({
      name: "claim_task",
      arguments: { id: "ready-task", agent: "finisher" },
    });

    // Finish
    const res = await client.callTool({
      name: "finish_task",
      arguments: { id: "ready-task", agent: "finisher" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.finished).toBe("ready-task");

    // Verify task is done
    const taskRes = await client.callTool({
      name: "get_task",
      arguments: { id: "ready-task" },
    });
    const taskText = (taskRes.content as Array<{ type: string; text: string }>)[0]!.text;
    const taskResult: any = JSON.parse(taskText);
    expect(taskResult.data.status).toBe("done");

    await client.close();
    await server.close();
  });

  test("finish_task rejects when task already done", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    // ready-task was finished in the previous test; try again
    const res = await client.callTool({
      name: "finish_task",
      arguments: { id: "ready-task", agent: "finisher" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("task_done");

    await client.close();
    await server.close();
  });

  test("create_handoff creates a handoff record", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "create_handoff",
      arguments: {
        task: "ready-task",
        from: "agent-a",
        to: "agent-b",
        summary: "Handing off mid-progress",
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.task).toBe("ready-task");
    expect(result.data.from_agent).toBe("agent-a");
    expect(result.data.to_agent).toBe("agent-b");
    expect(result.data.summary).toBe("Handing off mid-progress");

    await client.close();
    await server.close();
  });

  test("create_handoff rejects for unknown task", async () => {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);

    const res = await client.callTool({
      name: "create_handoff",
      arguments: { task: "no-such", from: "agent-a" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const result: any = JSON.parse(text);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("no_such_task");

    await client.close();
    await server.close();
  });
});
