import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitMutationEvent, onMutationEvent } from "../src/core/events.ts";
import { createApp } from "../src/dashboard/server.ts";

const testRoot = join(process.cwd(), ".waystation-test-dashboard");

function setupLedger() {
  rmSync(testRoot, { recursive: true, force: true });
  const ledger = join(testRoot, ".waystation");
  mkdirSync(join(ledger, "tasks"), { recursive: true });
  mkdirSync(join(ledger, "claims"), { recursive: true });
  mkdirSync(join(ledger, "messages"), { recursive: true });
  mkdirSync(join(ledger, "issues"), { recursive: true });
  mkdirSync(join(ledger, "handoffs"), { recursive: true });
  mkdirSync(join(ledger, "prompts"), { recursive: true });
  mkdirSync(join(ledger, "scopes"), { recursive: true });
  writeFileSync(join(ledger, "events.jsonl"), "");

  const task = {
    id: "test-task",
    title: "Test Task",
    status: "ready",
    priority: 1,
    dependencies: [],
    prompts: [],
    path_hints: [],
    acceptance: [],
    created_at: "2026-07-06T20:00:00+03:00",
    updated_at: "2026-07-06T20:00:00+03:00",
    description: "A test task.",
  };
  writeFileSync(join(ledger, "tasks", "test-task.json"), JSON.stringify(task, null, 2));
}

function teardownLedger() {
  rmSync(testRoot, { recursive: true, force: true });
}

describe("dashboard API server", () => {
  beforeAll(() => setupLedger());
  afterAll(() => teardownLedger());

  test("GET /api/status returns task counts and next task", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.counts.ready).toBe(1);
    expect(body.data.next.id).toBe("test-task");
  });

  test("GET /api/tasks lists all tasks", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].id).toBe("test-task");
  });

  test("GET /api/tasks?status=ready filters by status", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks?status=ready");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
  });

  test("GET /api/tasks?status=in_progress returns empty list", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks?status=in_progress");
    const body = await res.json();
    expect(body.data.length).toBe(0);
  });

  test("GET /api/tasks/:id returns a single task", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe("test-task");
    expect(body.data.title).toBe("Test Task");
  });

  test("GET /api/tasks/:id returns error for unknown task", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/nonexistent");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe("no_such_task");
  });

  test("GET /api/tasks/:id/brief returns task brief", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/brief");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.task.id).toBe("test-task");
  });

  test("POST /api/tasks/:id/claim claims a task", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "test-agent" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("active");
  });

  test("POST /api/tasks/:id/release releases a claimed task", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "test-agent" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("POST /api/issues creates an issue", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test Issue", severity: "low", type: "bug" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("Test Issue");
  });

  test("GET /api/issues lists issues", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/issues");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/validate returns validation result", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/validate");
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /api/events returns SSE content-type header", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("event bus emits and receives mutation events", () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = onMutationEvent((event) => events.push(event));

    emitMutationEvent({ type: "test", payload: "hello" });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("test");
    expect(events[0].payload).toBe("hello");

    unsub();
    emitMutationEvent({ type: "test2", payload: "world" });
    expect(events.length).toBe(1); // unsubscribed, no new events
  });

  test("GET /api/status after claim shows task in_progress", async () => {
    const app = createApp(testRoot);
    const claimRes = await app.request("/api/tasks/test-task/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "test-agent" }),
    });
    const claimBody = await claimRes.json();
    expect(claimBody.ok).toBe(true);

    const res = await app.request("/api/status");
    const body = await res.json();
    expect(body.data.counts.in_progress).toBe(1);
    expect(body.data.next).toBeNull();
  });

  test("POST /api/messages posts a message", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread: "test-task",
        from: "test-agent",
        body: "Hello, this is a test message.",
      }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.body).toBe("Hello, this is a test message.");
  });

  test("POST /api/handoffs creates a handoff", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "test-task",
        from: "test-agent",
        summary: "Handing off mid-progress.",
      }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.task).toBe("test-task");
  });
});
