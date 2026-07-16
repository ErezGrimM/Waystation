import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitMutationEvent, onMutationEvent } from "../src/core/events.ts";
import { createApp } from "../src/dashboard/server.ts";

const testRoot = join(process.cwd(), ".waystation-test-dashboard");

function setupLedger() {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: testRoot });
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
    path_hints: ["src/core/brief.ts"],
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
    expect(body.data.budget).toBe("medium");
  });

  test("GET /api/tasks/:id/brief passes budget through core validation", async () => {
    const app = createApp(testRoot);
    const full = await app.request("/api/tasks/test-task/brief?budget=full");
    const fullBody = await full.json();
    expect(fullBody.ok).toBe(true);
    expect(fullBody.data.budget).toBe("full");

    const invalid = await app.request("/api/tasks/test-task/brief?budget=tiny");
    const invalidBody = await invalid.json();
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.errors[0].code).toBe("invalid_brief_budget");
  });

  test("GET /api/tasks/:id/brief returns enriched brief with graph data", async () => {
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

    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/brief?budget=large");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.budget).toBe("large");
    expect(body.data.relatedFiles.length).toBeGreaterThan(0);
    expect(body.data.concepts.length).toBeGreaterThan(0);
    expect(body.data.impactHints).toBeDefined();
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

  test("GET /api/git/context returns git state and claim context", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/git/context");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.git.worktree).toBeTruthy();
    expect(Array.isArray(body.data.activeClaims)).toBe(true);
    expect(Array.isArray(body.data.overlaps)).toBe(true);
  });

  test("GET /api/events returns SSE content-type header", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  // M5: the SSE stream must forward mutation events to connected clients — this
  // is the contract the dashboard's live refresh (EventSource) depends on.
  test("GET /api/events forwards a mutation event to the stream", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // The stream subscribed on construction; emit a mutation event onto the bus.
    emitMutationEvent({ type: "task.claimed", task: "test-task", actor: "sse-test" });

    let text = "";
    for (let i = 0; i < 10 && !text.includes("data:"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += typeof value === "string" ? value : decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("data:");
    expect(text).toContain("task.claimed");
  });

  test("POST /api/git/commit rejects files outside the current status selection", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test", files: ["."] }),
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].message).toContain("invalid file selection");
  });

  test("POST /api/git/commit can link the created commit to a task", async () => {
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: testRoot });
    Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: testRoot });
    writeFileSync(join(testRoot, "commit-link.txt"), "hello");

    const app = createApp(testRoot);
    const res = await app.request("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "link commit to task",
        files: ["commit-link.txt"],
        task: "test-task",
      }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.commit).toBeTruthy();
    expect(body.data.task).toBe("test-task");

    const taskRes = await app.request("/api/tasks/test-task");
    const taskBody = await taskRes.json();
    expect(taskBody.data.commits).toContain(body.data.commit);
  });

  test("event bus emits and receives mutation events", () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = onMutationEvent((event) => events.push(event));

    emitMutationEvent({ type: "test", payload: "hello" });
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("test");
    expect(events[0]!.payload).toBe("hello");

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

  test("POST /api/gh/import returns no_github_token when token is missing", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/gh/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe("no_github_token");
  });

  test("POST /api/gh/export returns no_github_token when token is missing", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/gh/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe("no_github_token");
  });

  // H2: DNS-rebinding guard — a non-loopback request host is rejected.
  test("rejects requests whose host is not loopback (DNS-rebinding guard)", async () => {
    const app = createApp(testRoot);
    const res = await app.request(new Request("http://evil.example.com/api/status"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errors[0].code).toBe("forbidden_origin");
  });

  // H2: CSRF guard — a cross-origin mutating request is rejected before it runs.
  test("rejects cross-origin mutating requests (CSRF guard)", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
      body: JSON.stringify({ agent: "attacker" }),
    });
    expect(res.status).toBe(403);
  });

  // H2: a same-origin loopback mutating request still passes the guard.
  test("allows same-origin loopback mutating requests", async () => {
    const app = createApp(testRoot);
    const res = await app.request("/api/tasks/test-task/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ agent: "local-agent" }),
    });
    expect(res.status).not.toBe(403); // guard passed (200 claim, or 422 if already claimed)
  });

  // M1: static routes serve legit files but never escape their base directory.
  test("static route serves a file under graphify-out but not a traversal", async () => {
    const app = createApp(testRoot);
    const graphDir = join(testRoot, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
    writeFileSync(join(testRoot, "secret-marker.txt"), "TOP-SECRET-CONTENTS");

    const ok = await app.request("/graphify-out/graph.json");
    expect(ok.status).toBe(200);

    // A percent-encoded ../ traversal must not reach the sibling secret file.
    const evil = await app.request("/graphify-out/%2e%2e%2fsecret-marker.txt");
    const text = await evil.text();
    expect(text).not.toContain("TOP-SECRET-CONTENTS");

    rmSync(join(testRoot, "secret-marker.txt"), { force: true });
  });

  // M2: a malformed record surfaces a coded envelope without leaking the path.
  test("a malformed record does not leak the absolute file path", async () => {
    const app = createApp(testRoot);
    const badFile = join(testRoot, ".waystation", "tasks", "bad.json");
    writeFileSync(badFile, "{ this is not valid json");
    try {
      const res = await app.request("/api/tasks");
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(["invalid_json", "schema_invalid"]).toContain(body.errors[0].code);
      expect(body.errors[0].message).not.toContain(testRoot);
      expect(body.errors[0].message).not.toMatch(/[A-Za-z]:[\\/]/);
    } finally {
      rmSync(badFile, { force: true });
    }
  });
});
