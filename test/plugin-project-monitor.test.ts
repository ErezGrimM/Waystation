import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readClaims,
  readMessages,
  readTasks,
  SubprocessError,
} from "../integrations/hermes/desktop/waystation-data.ts";
import { initLedger } from "../src/core/init.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const claimsRead = fileURLToPath(
  new URL("../integrations/hermes/desktop/claims-read.ts", import.meta.url),
);
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "waystation-plugin-monitor-"));
  roots.push(root);
  await initLedger(root, { project: "test-project" });
  return root;
}

function run(root: string, args: string[]) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...args],
    cwd: root,
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function runClaims(root: string, args: string[]) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", claimsRead, ...args],
    cwd: root,
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("plugin project monitor data access", () => {
  test("readTasks returns tasks from the ledger via CLI subprocess", async () => {
    const root = await fixture();
    const created = run(root, [
      "task",
      "create",
      "task-alpha",
      "--title",
      "Alpha task",
      "--status",
      "todo",
      "--priority",
      "1",
      "--json",
    ]);
    expect(created.code).toBe(0);

    const tasks = await readTasks(root);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe("task-alpha");
    expect(tasks[0]!.title).toBe("Alpha task");
    expect(tasks[0]!.status).toBe("todo");
  });

  test("readClaims returns claims via the allowlisted adapter", async () => {
    const root = await fixture();
    run(root, [
      "task",
      "create",
      "task-beta",
      "--title",
      "Beta task",
      "--status",
      "ready",
      "--json",
    ]);
    run(root, ["task", "claim", "task-beta", "--agent", "agent-x", "--json"]);

    const claims = await readClaims(root);
    expect(claims.length).toBe(1);
    expect(claims[0]!.task).toBe("task-beta");
    expect(claims[0]!.agent).toBe("agent-x");
    expect(claims[0]!.status).toBe("active");
  });

  test("readMessages returns messages for a thread via CLI subprocess", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-gamma", "--title", "Gamma task", "--json"]);
    run(root, [
      "message",
      "post",
      "--thread",
      "task-gamma",
      "--from",
      "agent-a",
      "--body",
      "Working on it",
      "--json",
    ]);

    const messages = await readMessages(root, "task-gamma");
    expect(messages.length).toBe(1);
    expect(messages[0]!.from_agent).toBe("agent-a");
    expect(messages[0]!.body).toBe("Working on it");
    expect(messages[0]!.thread).toBe("task-gamma");
  });

  test("readTasks returns empty array for a fresh ledger with no tasks", async () => {
    const root = await fixture();
    const tasks = await readTasks(root);
    expect(tasks).toEqual([]);
  });

  test("readClaims returns empty array for a fresh ledger with no claims", async () => {
    const root = await fixture();
    const claims = await readClaims(root);
    expect(claims).toEqual([]);
  });

  test("readMessages returns empty array for a thread with no messages", async () => {
    const root = await fixture();
    const messages = await readMessages(root, "nonexistent-thread");
    expect(messages).toEqual([]);
  });

  test("readTasks throws SubprocessError for a missing ledger root", async () => {
    const missingRoot = join(tmpdir(), "waystation-missing-ledger-xyz");
    await expect(readTasks(missingRoot)).rejects.toThrow(SubprocessError);
  });

  test("readClaims throws SubprocessError for a missing ledger root", async () => {
    const missingRoot = join(tmpdir(), "waystation-missing-ledger-xyz");
    await expect(readClaims(missingRoot)).rejects.toThrow(SubprocessError);
  });

  test("readMessages throws SubprocessError for a missing ledger root", async () => {
    const missingRoot = join(tmpdir(), "waystation-missing-ledger-xyz");
    await expect(readMessages(missingRoot, "some-thread")).rejects.toThrow(SubprocessError);
  });

  test("readTasks does not mutate the ledger (read-only verification)", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-readonly", "--title", "Read-only test", "--json"]);

    const before = readFileSync(join(root, ".waystation", "tasks", "task-readonly.json"), "utf8");
    const eventsBefore = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");

    await readTasks(root);
    await readClaims(root);
    await readMessages(root, "task-readonly");

    const after = readFileSync(join(root, ".waystation", "tasks", "task-readonly.json"), "utf8");
    const eventsAfter = readFileSync(join(root, ".waystation", "events.jsonl"), "utf8");

    expect(after).toBe(before);
    expect(eventsAfter).toBe(eventsBefore);
  });

  test("readTasks handles multiple tasks with different statuses", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-1", "--title", "Task 1", "--json"]);
    run(root, ["task", "create", "task-2", "--title", "Task 2", "--status", "ready", "--json"]);
    run(root, ["task", "create", "task-3", "--title", "Task 3", "--status", "done", "--json"]);

    const tasks = await readTasks(root);
    expect(tasks.length).toBe(3);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("task-1");
    expect(ids).toContain("task-2");
    expect(ids).toContain("task-3");
  });

  test("readMessages returns messages in chronological order", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-order", "--title", "Order test", "--json"]);
    run(root, [
      "message",
      "post",
      "--thread",
      "task-order",
      "--from",
      "agent-a",
      "--body",
      "First message",
      "--json",
    ]);
    run(root, [
      "message",
      "post",
      "--thread",
      "task-order",
      "--from",
      "agent-b",
      "--body",
      "Second message",
      "--json",
    ]);

    const messages = await readMessages(root, "task-order");
    expect(messages.length).toBe(2);
    expect(messages[0]!.body).toBe("First message");
    expect(messages[1]!.body).toBe("Second message");
  });

  test("readClaims returns only active claims for active claim check", async () => {
    const root = await fixture();
    run(root, [
      "task",
      "create",
      "task-claim-check",
      "--title",
      "Claim check",
      "--status",
      "ready",
      "--json",
    ]);
    run(root, ["task", "claim", "task-claim-check", "--agent", "agent-1", "--json"]);

    const claims = await readClaims(root);
    const activeClaims = claims.filter((c) => c.status === "active");
    expect(activeClaims.length).toBe(1);
    expect(activeClaims[0]!.agent).toBe("agent-1");
  });
});

describe("plugin project monitor CLI integration", () => {
  test("CLI task list --json returns CommandResult envelope", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-env", "--title", "Envelope test", "--json"]);

    const result = run(root, ["task", "list", "--root", root, "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBe(1);
  });

  test("CLI message list --json returns raw array (not CommandResult)", async () => {
    const root = await fixture();
    run(root, ["task", "create", "task-raw", "--title", "Raw test", "--json"]);
    run(root, [
      "message",
      "post",
      "--thread",
      "task-raw",
      "--from",
      "agent-x",
      "--body",
      "Test",
      "--json",
    ]);

    const result = run(root, ["message", "list", "--thread", "task-raw", "--root", root, "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });

  test("claims adapter returns CommandResult envelope", async () => {
    const root = await fixture();
    run(root, [
      "task",
      "create",
      "task-claim-env",
      "--title",
      "Claim envelope",
      "--status",
      "ready",
      "--json",
    ]);
    run(root, ["task", "claim", "task-claim-env", "--agent", "agent-y", "--json"]);

    const result = runClaims(root, ["--root", root]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBe(1);
  });
});
