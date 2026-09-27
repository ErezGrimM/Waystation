import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { claimTask, releaseTask, setTaskStatus } from "../src/core/mutate.ts";
import {
  appendEventUnlocked,
  buildIntent,
  hasPendingIntent,
  LockError,
  loadClaimFiles,
  mutationWrite,
  withLedgerLock,
  withLedgerReadLock,
} from "../src/core/store.ts";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

const TASK_READY = {
  id: "task-ready",
  title: "Ready",
  status: "ready",
  priority: 1,
  dependencies: [],
};

function fixtureRoot(records: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-persist-"));
  tmpRoots.push(root);
  const tasksDir = join(root, ".waystation", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (const rec of records) {
    writeFileSync(join(tasksDir, `${rec.id as string}.json`), JSON.stringify(rec, null, 2));
  }
  return root;
}

function intentFile(root: string): string {
  return join(root, ".waystation", "mutation-intent.json");
}

function writeIntent(root: string, intent: unknown): void {
  writeFileSync(intentFile(root), JSON.stringify(intent, null, 2));
}

function readEvents(root: string): Array<Record<string, unknown>> {
  const file = join(root, ".waystation", "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("malformed legacy writes and events fail before any recovery write", async () => {
  for (const bad of [
    { writes: [{ path: "tasks/bad.json" }], events: [] },
    { writes: [], events: [null] },
  ]) {
    const root = fixtureRoot([TASK_READY]);
    const before = readFileSync(join(root, ".waystation", "tasks", "task-ready.json"), "utf8");
    writeIntent(root, {
      version: 1,
      id: "malformed",
      kind: "test",
      writes: [
        { path: "tasks/task-ready.json", value: { ...TASK_READY, title: "must not write" } },
        ...bad.writes,
      ],
      events: bad.events,
    });
    await expect(withLedgerLock(root, () => undefined)).rejects.toThrow();
    expect(readFileSync(join(root, ".waystation", "tasks", "task-ready.json"), "utf8")).toBe(
      before,
    );
    expect(existsSync(intentFile(root))).toBe(true);
  }
});

test("a complete JSON event without its newline is safely terminated during recovery", async () => {
  const root = fixtureRoot([TASK_READY]);
  const events = join(root, ".waystation", "events.jsonl");
  writeFileSync(events, '{"type":"old"}');
  writeIntent(
    root,
    buildIntent({ id: "tail", kind: "test", writes: [], events: [{ type: "new" }] }),
  );
  await withLedgerLock(root, () => undefined);
  expect(readEvents(root).map((event) => event.type)).toEqual(["old", "new"]);
  expect(existsSync(intentFile(root))).toBe(false);
});

describe("W01a: lock acquisition split", () => {
  test("the read path never creates the ledger directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-read-nocreate-"));
    tmpRoots.push(root);
    await expect(withLedgerReadLock(root, () => undefined)).rejects.toThrow();
    expect(existsSync(join(root, ".waystation"))).toBe(false);
  });

  test("the read path does not sweep orphan temporaries", async () => {
    const root = fixtureRoot([TASK_READY]);
    const stray = join(root, ".waystation", "tasks", "stray.tmp");
    writeFileSync(stray, "orphan");
    await withLedgerReadLock(root, () => undefined);
    expect(existsSync(stray)).toBe(true);
  });

  test("the read path refuses a pending intent with a coded diagnostic and preserves it", async () => {
    const root = fixtureRoot([TASK_READY]);
    writeIntent(root, {
      version: 2,
      id: "pending-read-block",
      kind: "task.update",
      writes: [{ path: "tasks/task-ready.json", value: { ...TASK_READY, status: "done" } }],
      events: [{ id: "0", payload: { type: "task.updated", task: "task-ready" } }],
    });
    await expect(withLedgerReadLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(intentFile(root))).toBe(true);
    expect(hasPendingIntent(root)).toBe(true);
  });

  test("a junction alias of the ledger contends on the same lock", async () => {
    const root = fixtureRoot([TASK_READY]);
    const aliasDir = mkdtempSync(join(tmpdir(), "waystation-alias-"));
    tmpRoots.push(aliasDir);
    symlinkSync(join(root, ".waystation"), join(aliasDir, ".waystation"), "junction");

    // Both paths must canonicalize to one lock target.
    expect(realpathSync(join(aliasDir, ".waystation"))).toBe(
      realpathSync(join(root, ".waystation")),
    );

    const release = await lockfile.lock(realpathSync(join(aliasDir, ".waystation")), {
      realpath: false,
      retries: 0,
      stale: 60_000,
    });
    try {
      const err = await withLedgerLock(root, () => undefined).catch((e) => e);
      expect(err).toBeInstanceOf(LockError);
      expect((err as LockError).code).toBe("lock_contended");
    } finally {
      await release();
    }
  });
});

describe("W01b: version-2 intents with stable event identity", () => {
  test("recovery appends the exact missing suffix after a crash mid-batch (regression)", async () => {
    const root = fixtureRoot([TASK_READY]);
    const taskFile = join(root, ".waystation", "tasks", "task-ready.json");
    const intent = buildIntent({
      id: "mutation-mid-batch",
      kind: "task.update",
      writes: [mutationWrite(root, taskFile, { ...TASK_READY, status: "done" })],
      events: [
        { type: "task.status_changed", task: "task-ready", from: "ready", to: "done" },
        { type: "task.updated", task: "task-ready" },
        { type: "task.commits_attached", task: "task-ready", commits: ["abcdef0"] },
      ],
    });
    // Simulate a crash after the intent and only the first event were durably
    // written. The old batch-level check would treat that one event as proof
    // the whole batch landed and silently drop the remaining two events.
    writeIntent(root, intent);
    const first = intent.events[0];
    appendEventUnlocked(root, {
      ...first!.payload,
      mutation: intent.id,
      intent_event: first!.id,
    });

    await withLedgerLock(root, () => undefined);

    const mine = readEvents(root).filter((event) => event.mutation === intent.id);
    expect(mine.map((event) => event.intent_event)).toEqual(["0", "1", "2"]);
    expect(existsSync(intentFile(root))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, ".waystation", "tasks", "task-ready.json"), "utf8"))
        .status,
    ).toBe("done");
  });

  test("recovery is idempotent: fully-appended events are not duplicated", async () => {
    const root = fixtureRoot([TASK_READY]);
    const taskFile = join(root, ".waystation", "tasks", "task-ready.json");
    const intent = buildIntent({
      id: "mutation-idempotent",
      kind: "task.update",
      writes: [mutationWrite(root, taskFile, { ...TASK_READY, status: "done" })],
      events: [
        { type: "task.status_changed", task: "task-ready", from: "ready", to: "done" },
        { type: "task.updated", task: "task-ready" },
      ],
    });
    writeIntent(root, intent);
    for (const event of intent.events) {
      appendEventUnlocked(root, {
        ...event.payload,
        mutation: intent.id,
        intent_event: event.id,
      });
    }

    await withLedgerLock(root, () => undefined);

    expect(readEvents(root).filter((event) => event.mutation === intent.id)).toHaveLength(2);
    expect(existsSync(intentFile(root))).toBe(false);
  });

  test("a conflicting already-appended payload is a recovery error preserving the intent", async () => {
    const root = fixtureRoot([TASK_READY]);
    const taskFile = join(root, ".waystation", "tasks", "task-ready.json");
    const intent = buildIntent({
      id: "mutation-conflict",
      kind: "task.update",
      writes: [mutationWrite(root, taskFile, { ...TASK_READY, status: "done" })],
      events: [
        { type: "task.status_changed", task: "task-ready", from: "ready", to: "done" },
        { type: "task.updated", task: "task-ready" },
      ],
    });
    writeIntent(root, intent);
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: "task-ready",
      from: "ready",
      to: "WRONG",
      mutation: intent.id,
      intent_event: "0",
    });

    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(intentFile(root))).toBe(true);
  });

  test("a gap in the appended event prefix is a recovery error", async () => {
    const root = fixtureRoot([TASK_READY]);
    const intent = buildIntent({
      id: "mutation-gap",
      kind: "task.update",
      writes: [],
      events: [
        { type: "task.updated", task: "task-ready" },
        { type: "task.status_changed", task: "task-ready", to: "done" },
      ],
    });
    writeIntent(root, intent);
    // Append only the SECOND event identity; the first is missing.
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: "task-ready",
      to: "done",
      mutation: intent.id,
      intent_event: "1",
    });

    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(intentFile(root))).toBe(true);
  });

  test("duplicate event identities in an intent are rejected", async () => {
    const root = fixtureRoot([TASK_READY]);
    writeIntent(root, {
      version: 2,
      id: "mutation-dup-id",
      kind: "test",
      writes: [],
      events: [
        { id: "0", payload: { type: "a" } },
        { id: "0", payload: { type: "b" } },
      ],
    });
    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
  });

  test("a write target escaping the ledger is refused and preserved", async () => {
    const root = fixtureRoot([TASK_READY]);
    writeIntent(root, {
      version: 2,
      id: "mutation-escape",
      kind: "test",
      writes: [{ path: "../evil.json", value: { id: "evil" } }],
      events: [],
    });
    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(join(root, "evil.json"))).toBe(false);
    expect(existsSync(intentFile(root))).toBe(true);
  });

  test("a write target escaping through a junction is refused", async () => {
    const root = fixtureRoot([TASK_READY]);
    const outside = mkdtempSync(join(tmpdir(), "waystation-outside-"));
    tmpRoots.push(outside);
    symlinkSync(outside, join(root, ".waystation", "tasks", "escape"), "junction");
    writeIntent(root, {
      version: 2,
      id: "mutation-junction",
      kind: "test",
      writes: [{ path: "tasks/escape/evil.json", value: { id: "evil" } }],
      events: [],
    });
    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(join(outside, "evil.json"))).toBe(false);
  });

  test("a separate process recovers an interrupted mutation (cross-process fixture)", async () => {
    const root = mkdtempSync(join(tmpdir(), "waystation-separate-"));
    tmpRoots.push(root);
    const fixture = fileURLToPath(new URL("./fixtures/interrupted-mutation.ts", import.meta.url));
    const proc = Bun.spawnSync([process.execPath, "run", fixture, root]);
    expect(proc.exitCode).toBe(0);
    expect(existsSync(intentFile(root))).toBe(true);

    await withLedgerLock(root, () => undefined);

    const mine = readEvents(root).filter((event) => event.mutation === "mutation-separate-process");
    expect(mine.map((event) => event.intent_event)).toEqual(["0", "1", "2"]);
    expect(existsSync(intentFile(root))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, ".waystation", "tasks", "task-separate.json"), "utf8"))
        .status,
    ).toBe("done");
  });
});

describe("W01c: version-1 recovery compatibility and producer migration", () => {
  test("a v1 intent recovers on an exact ordered event prefix", async () => {
    const root = fixtureRoot([TASK_READY]);
    writeIntent(root, {
      version: 1,
      id: "mutation-v1-prefix",
      kind: "task.update",
      writes: [{ path: "tasks/task-ready.json", value: { ...TASK_READY, status: "done" } }],
      events: [
        { type: "task.status_changed", task: "task-ready", to: "done" },
        { type: "task.updated", task: "task-ready" },
      ],
    });
    appendEventUnlocked(root, {
      type: "task.status_changed",
      task: "task-ready",
      to: "done",
      mutation: "mutation-v1-prefix",
    });

    await withLedgerLock(root, () => undefined);

    const mine = readEvents(root).filter((event) => event.mutation === "mutation-v1-prefix");
    expect(mine.map((event) => event.type)).toEqual(["task.status_changed", "task.updated"]);
    expect(existsSync(intentFile(root))).toBe(false);
  });

  test("v1 recovery compares repeated identical payloads by position, not set membership", async () => {
    const root = fixtureRoot([TASK_READY]);
    const identical = { type: "task.note", task: "task-ready" };
    writeIntent(root, {
      version: 1,
      id: "mutation-v1-repeat",
      kind: "test",
      writes: [],
      events: [identical, identical],
    });
    // Only one copy was appended before the crash; recovery must append the second.
    appendEventUnlocked(root, { ...identical, mutation: "mutation-v1-repeat" });

    await withLedgerLock(root, () => undefined);

    expect(
      readEvents(root).filter((event) => event.mutation === "mutation-v1-repeat"),
    ).toHaveLength(2);
  });

  test("a torn event log refuses v1 recovery and preserves the intent", async () => {
    const root = fixtureRoot([TASK_READY]);
    writeIntent(root, {
      version: 1,
      id: "mutation-v1-torn",
      kind: "test",
      writes: [],
      events: [{ type: "task.note", task: "task-ready" }],
    });
    writeFileSync(join(root, ".waystation", "events.jsonl"), '{"type":"task.note"}\n{broken');

    await expect(withLedgerLock(root, () => undefined)).rejects.toMatchObject({
      code: "mutation_intent_invalid",
    });
    expect(existsSync(intentFile(root))).toBe(true);
  });

  test("mutations emit version-2 events with per-event identity", async () => {
    const root = fixtureRoot([TASK_READY]);
    await setTaskStatus(root, "task-ready", "wont_do", "tester", new Date("2026-07-06T10:00:00Z"));

    const event = readEvents(root).find((e) => e.type === "task.status_changed");
    expect(event).toBeDefined();
    expect(event!.intent_event).toBe("0");
    expect(event!.mutation).toMatch(/^mutation-task-status-/);
  });
});

describe("W01d: record-path preservation and claim round-trip", () => {
  test("unknown claim fields survive a release mutation", async () => {
    const root = fixtureRoot([TASK_READY]);
    await claimTask(root, "task-ready", "agent-x", new Date("2026-07-06T10:00:00Z"));
    const [loaded] = loadClaimFiles(root);
    const claimFile = loaded!.file;
    const raw = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
    raw.custom_field = "preserve-me";
    raw.extra = { nested: 42 };
    writeFileSync(claimFile, JSON.stringify(raw, null, 2));

    await releaseTask(root, "task-ready", "agent-x", new Date("2026-07-06T10:00:05Z"));

    const reloaded = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
    expect(reloaded.status).toBe("released");
    expect(reloaded.custom_field).toBe("preserve-me");
    expect(reloaded.extra).toEqual({ nested: 42 });
  });

  test("a claim loaded from a non-canonical filename writes back to that file", async () => {
    const root = fixtureRoot([TASK_READY]);
    const claimsDir = join(root, ".waystation", "claims");
    mkdirSync(claimsDir, { recursive: true });
    const altFile = join(claimsDir, "alt-name.json");
    writeFileSync(
      altFile,
      JSON.stringify(
        {
          id: "claim-custom",
          task: "task-ready",
          agent: "agent-x",
          status: "active",
          claimed_at: "2026-07-06T10:00:00+03:00",
          released_at: null,
          completed_at: null,
          custom_field: "keep",
        },
        null,
        2,
      ),
    );

    await releaseTask(root, "task-ready", "agent-x", new Date("2026-07-06T10:00:05Z"));

    expect(existsSync(join(claimsDir, "claim-custom.json"))).toBe(false);
    const reloaded = JSON.parse(readFileSync(altFile, "utf8")) as Record<string, unknown>;
    expect(reloaded.status).toBe("released");
    expect(reloaded.custom_field).toBe("keep");
  });
});
