/**
 * Separate-process recovery fixture. Creates a fresh ledger, persists a
 * version-2 mutation intent, and appends only the FIRST expected event before
 * exiting — simulating a process that crashed mid-batch. The test process then
 * recovers the intent and must append the exact missing event suffix.
 *
 * Usage: bun run test/fixtures/interrupted-mutation.ts <root>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendEventUnlocked,
  buildIntent,
  mutationWrite,
  writeJsonAtomic,
} from "../../src/core/store.ts";

const root = process.argv[2];
if (!root) throw new Error("usage: interrupted-mutation.ts <root>");

const ledger = join(root, ".waystation");
mkdirSync(join(ledger, "tasks"), { recursive: true });

const task = {
  id: "task-separate",
  title: "Separate process",
  status: "ready",
  priority: 1,
  dependencies: [],
  path_hints: [],
  prompts: [],
  acceptance: [],
  created_at: "2026-07-06T10:00:00+03:00",
  updated_at: "2026-07-06T10:00:00+03:00",
};
const taskFile = join(ledger, "tasks", "task-separate.json");
writeFileSync(taskFile, JSON.stringify(task, null, 2));

const intent = buildIntent({
  id: "mutation-separate-process",
  kind: "task.update",
  writes: [mutationWrite(root, taskFile, { ...task, status: "done" })],
  events: [
    { type: "task.status_changed", task: "task-separate", from: "ready", to: "done" },
    { type: "task.updated", task: "task-separate" },
    { type: "task.git_reconciled", task: "task-separate" },
  ],
});

// Persist the intent, then simulate a crash after only the first event landed.
writeJsonAtomic(join(ledger, "mutation-intent.json"), intent);
const first = intent.events[0];
if (!first) throw new Error("fixture intent has no events");
appendEventUnlocked(root, { ...first.payload, mutation: intent.id, intent_event: first.id });
// "Crash": exit without appending the remaining events or removing the intent.
