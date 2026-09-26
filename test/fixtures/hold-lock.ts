/**
 * Separate-process contention fixture. Acquires the ledger lock on a fixture
 * ledger, writes a marker so the parent can observe that the lock is held by a
 * DIFFERENT process, holds the lock for a bounded, parameterised time, then
 * releases and exits.
 *
 * The marker is written only after the lock is acquired, so the parent can poll
 * for it instead of racing the acquire with a bare sleep (deterministic sync).
 *
 * Usage: bun run test/fixtures/hold-lock.ts <root> <holdMs> <markerFile>
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const [root, holdMsRaw, markerFile] = process.argv.slice(2);
if (!root || !holdMsRaw || !markerFile) {
  throw new Error("usage: hold-lock.ts <root> <holdMs> <markerFile>");
}
const holdMs = Number(holdMsRaw);
if (!Number.isFinite(holdMs) || holdMs < 0) {
  throw new Error(`holdMs must be a non-negative number, got: ${holdMsRaw}`);
}

// Match store.ts's canonical lock target exactly: realpathSync(join(root,
// ".waystation")). proper-lockfile then contends on the same <ledger>.lock file
// in the root that the parent's withLedgerLock uses.
const ledger = join(root, ".waystation");
mkdirSync(ledger, { recursive: true });

const release = await lockfile.lock(realpathSync(ledger), {
  realpath: false,
  retries: 0,
  stale: 60_000,
});
try {
  writeFileSync(markerFile, String(process.pid));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
} finally {
  await release();
}
