import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    path_hints: [],
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
    expect(names).toContain("get_brief");
    expect(names).toContain("render_prompt");
    expect(names).toContain("list_issues");
    expect(names).toContain("get_inbox");
    expect(names).toContain("get_git_context");
    expect(names).toContain("validate_ledger");
    expect(names).toContain("claim_task");
    expect(names).toContain("release_task");
    expect(names).toContain("finish_task");
    expect(names).toContain("create_handoff");
    expect(names).toContain("post_message");
    expect(names).toContain("create_issue");
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
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
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
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
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
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
    expect(result.ok).toBe(true);
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
    const claimText = (claimRes.content as Array<{ type: string; text: string }>)[0].text;
    const claimResult = JSON.parse(claimText);
    expect(claimResult.ok).toBe(true);
    expect(claimResult.data.task).toBe("test-task");
    expect(claimResult.data.status).toBe("active");

    const taskRes = await client.callTool({
      name: "get_task",
      arguments: { id: "test-task" },
    });
    const taskText = (taskRes.content as Array<{ type: string; text: string }>)[0].text;
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
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
    expect(result.ok).toBe(true);
    expect(result.data.task.id).toBe("test-task");
    expect(result.data.task.status).toBe("in_progress");
    expect(result.data.activeClaim).not.toBeNull();

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
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
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
    const relText = (relRes.content as Array<{ type: string; text: string }>)[0].text;
    const relResult = JSON.parse(relText);
    expect(relResult.ok).toBe(true);

    const taskRes = await client.callTool({
      name: "get_task",
      arguments: { id: "test-task" },
    });
    const taskText = (taskRes.content as Array<{ type: string; text: string }>)[0].text;
    const taskResult = JSON.parse(taskText);
    expect(taskResult.data.status).toBe("ready");

    await client.close();
    await server.close();
  });
});
