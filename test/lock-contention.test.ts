import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withLedgerLock } from "../src/core/store.ts";

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const r of fixtureRoots) rmSync(r, { recursive: true, force: true });
});

// Fixture ledgers live under .fixtures/ in this worktree (git-excluded). The
// environment contract forbids $TEMP for fixtures, so we never use tmpdir().
function contentionRoot(): string {
  const base = fileURLToPath(new URL("../.fixtures", import.meta.url));
  mkdirSync(base, { recursive: true });
  const root = join(base, `contention-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, ".waystation", "tasks"), { recursive: true });
  fixtureRoots.push(root);
  return root;
}

const TASK_READY = {
  id: "task-ready",
  title: "Ready",
  status: "ready",
  priority: 1,
  dependencies: [],
};

const HOLD_MS = 1500;

describe("W01a cross-process lock contention (F2)", () => {
  test("withLedgerLock waits for a holder in another process and then succeeds", async () => {
    const root = contentionRoot();
    writeFileSync(
      join(root, ".waystation", "tasks", "task-ready.json"),
      JSON.stringify(TASK_READY, null, 2),
    );
    const marker = join(root, "hold-lock.marker");
    const fixture = fileURLToPath(new URL("./fixtures/hold-lock.ts", import.meta.url));

    const child = Bun.spawn([process.execPath, "run", fixture, root, String(HOLD_MS), marker], {
      stdout: "ignore",
      stderr: "pipe",
    });

    // Deterministic sync: poll for the marker the child writes only after it
    // has acquired the lock, so we never race the acquire (no bare sleep).
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(marker)).toBe(true);

    const start = Date.now();
    let ran = false;
    await withLedgerLock(root, () => {
      ran = true;
    });
    const elapsed = Date.now() - start;

    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`hold-lock fixture exited ${exitCode}: ${stderr}`);
    }

    expect(ran).toBe(true);
    // The lock was genuinely contended: the parent could not proceed until the
    // child released. The floor proves it waited a meaningful fraction of the
    // child's hold rather than acquiring immediately; the marker gate already
    // made the acquire deterministic, so this is not a timing race.
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS * 0.5);
  });
});
