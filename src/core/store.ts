import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ledgerPaths } from "./paths.ts";
import { RecordError } from "./records.ts";
import { type ClaimRecord, ClaimRecord as ClaimSchema } from "./schema.ts";

/** Atomically write a JSON record: write to a temp file, then rename over. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** Append one JSON object as a line to events.jsonl. */
export function appendEvent(root: string, event: Record<string, unknown>): void {
  const paths = ledgerPaths(root);
  mkdirSync(paths.ledger, { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  // appendFileSync creates the file if missing.
  writeFileSync(paths.events, line, { flag: "a", encoding: "utf8" });
}

/**
 * Run a mutation while holding a single ledger-wide write lock (spec §12).
 * The CLI, dashboard, and MCP layers must all funnel writes through here.
 */
export async function withLedgerLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const paths = ledgerPaths(root);
  mkdirSync(paths.ledger, { recursive: true });
  const release = await lockfile.lock(paths.ledger, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 15_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function claimFile(root: string, id: string): string {
  return join(ledgerPaths(root).claims, `${id}.json`);
}

export function writeClaim(root: string, claim: ClaimRecord): void {
  writeJsonAtomic(claimFile(root, claim.id), claim);
}

/** Load and validate all claim records. */
export function loadClaims(root?: string): ClaimRecord[] {
  const dir = ledgerPaths(root).claims;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const claims: ClaimRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const parsed = ClaimSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      throw new RecordError(file, `schema: ${parsed.error.issues[0]?.message ?? "invalid claim"}`);
    }
    claims.push(parsed.data);
  }
  return claims;
}

export function activeClaimForTask(root: string, taskId: string): ClaimRecord | undefined {
  return loadClaims(root).find((c) => c.task === taskId && c.status === "active");
}
