import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimTask, finishTask } from "../src/core/mutate.ts";
import { validateLedger } from "../src/core/validate.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const base = join(import.meta.dirname, "..", ".fixtures");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "event-integrity-"));
  roots.push(root);
  const tasks = join(root, ".waystation", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(
    join(tasks, "task-one.json"),
    JSON.stringify({
      id: "task-one",
      title: "One",
      status: "ready",
      priority: 1,
      dependencies: [],
    }),
  );
  return root;
}

function removeEvent(root: string, type: string): void {
  const file = join(root, ".waystation", "events.jsonl");
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const index = lines.findIndex((line) => JSON.parse(line).type === type);
  expect(index).toBeGreaterThanOrEqual(0);
  lines.splice(index, 1);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

test("missing claim transition identifies its mutation and fails CLI validation", async () => {
  const root = fixture();
  const claim = await claimTask(root, "task-one", "test", new Date("2026-10-05T12:00:00Z"));
  removeEvent(root, "task.status_changed");
  const result = validateLedger(root);
  expect(result.ok).toBe(false);
  expect(
    result.errors.some(
      (error) =>
        error.code === "event_history_incomplete" &&
        error.details?.mutation === `mutation-claim-${claim.id}`,
    ),
  ).toBe(true);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli/index.ts", "--root", root, "validate"],
    {
      cwd: join(import.meta.dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stdout).text()).toContain(`mutation-claim-${claim.id}`);
});

test("missing completion event and stale status history are both reported", async () => {
  const root = fixture();
  const claim = await claimTask(root, "task-one", "test", new Date("2026-10-05T12:00:00Z"));
  await finishTask(root, "task-one", "test", new Date("2026-10-05T12:01:00Z"));
  expect(validateLedger(root).ok).toBe(true);
  removeEvent(root, "claim.completed");
  let result = validateLedger(root);
  expect(result.ok).toBe(false);
  expect(
    result.errors.some(
      (error) =>
        error.code === "event_history_incomplete" &&
        error.message.includes(`claim.completed for ${claim.id}`) &&
        String(error.details?.mutation).startsWith("mutation-finish-"),
    ),
  ).toBe(true);

  // A stale branch can bring back an older event snapshot while keeping the
  // newer task and claim records. The append-order chain must expose it.
  const events = join(root, ".waystation", "events.jsonl");
  const claimOnly = readFileSync(events, "utf8")
    .split("\n")
    .filter((line) => line && !line.includes('"to":"done"'));
  writeFileSync(events, `${claimOnly.join("\n")}\n`);
  result = validateLedger(root);
  expect(
    result.errors.some(
      (error) => error.code === "event_status_divergence" && error.details?.task === "task-one",
    ),
  ).toBe(true);
});

test("a pending valid journal is an integrity error with its mutation ID", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".waystation", "mutation-intent.json"),
    JSON.stringify({
      version: 2,
      id: "mutation-claim-interrupted",
      kind: "task.claim",
      writes: [],
      events: [],
    }),
  );
  const result = validateLedger(root);
  expect(result.ok).toBe(false);
  expect(result.errors).toContainEqual(
    expect.objectContaining({
      code: "mutation_intent_pending",
      details: { file: "mutation-intent.json", mutation: "mutation-claim-interrupted" },
    }),
  );
});
