import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ledgerPaths } from "./paths.ts";
import { RecordError } from "./records.ts";
import {
  type ClaimRecord,
  ClaimRecord as ClaimSchema,
  type IssueRecord,
  IssueRecord as IssueSchema,
} from "./schema.ts";

/**
 * Fsync a directory to ensure renamed entries are durable. On POSIX, a rename
 * only updates the directory entry; without an fsync, a crash can lose the
 * mapping. On Windows NTFS this is a no-op (NTFS journals metadata) but the
 * call is harmless.
 */
function fsyncDir(dir: string): void {
  // On Windows NTFS, directory fsync is not supported (NTFS journals metadata
  // automatically). The call throws EPERM, so we skip it on Windows (audit M3).
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

let tempFileCounter = 0;

/**
 * Sweep orphaned *.tmp files left behind by crashed processes. A temp file is
 * any file matching `*.pid.counter.tmp` in a ledger subdirectory. This runs
 * once per process on first lock acquisition (audit M4).
 */
/**
 * Delete every `*.tmp` file in the ledger's record directories. Callers MUST
 * hold the ledger lock: because all writes funnel through the lock, any `*.tmp`
 * present while it is held is genuinely orphaned, never a live writer's
 * in-flight temp.
 */
export function sweepTmpDirs(root: string): void {
  const paths = ledgerPaths(root);
  const dirs = [
    paths.tasks,
    paths.claims,
    paths.messages,
    join(paths.ledger, "issues"),
    join(paths.ledger, "handoffs"),
  ];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".tmp")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore — file may still be open by another process
        }
      }
    }
  }
}

let tmpSwept = false;
export function sweepOrphanTmp(root: string): void {
  if (tmpSwept) return;
  tmpSwept = true;
  sweepTmpDirs(root);
}

/** Parse a JSON file, raising a coded RecordError on malformed JSON. */
export function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new RecordError(file, `cannot read file: ${(err as Error).message}`, "invalid_json");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RecordError(file, `invalid JSON: ${(err as Error).message}`, "invalid_json");
  }
}

/**
 * Atomically and durably write a JSON record: write to a unique temp file,
 * fsync it, then rename over the target. The unique temp name (pid + random)
 * prevents concurrent writers to the same record from clobbering each other's
 * temp file (issue-event-log-atomicity).
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tempFileCounter}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameWithRetry(tmp, file);
  // fsync the parent directory so the rename is durable (audit M3).
  fsyncDir(join(file, ".."));
}

/**
 * Rename over the target, retrying briefly on Windows sharing violations.
 * On Windows, `rename` fails with EPERM/EACCES/EBUSY when another process
 * (a polling dashboard read, antivirus, a file indexer) has the destination
 * open. A short bounded backoff turns those transient collisions into success
 * instead of a half-applied mutation.
 */
function renameWithRetry(tmp: string, file: string): void {
  const delaysMs = [1, 2, 5, 10, 25, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= delaysMs.length) throw err;
      Atomics.wait(sleepBuffer, 0, 0, delaysMs[attempt]);
    }
  }
}

/** A private buffer used to perform a synchronous sleep via Atomics.wait. */
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Append one event line to events.jsonl. Uses a single O_APPEND write + fsync
 * so the line is written atomically and durably. Callers that already hold the
 * ledger lock (mutations) should use this directly; standalone callers should
 * use `appendEvent`, which takes the lock.
 */
export function appendEventUnlocked(root: string, event: Record<string, unknown>): void {
  const paths = ledgerPaths(root);
  mkdirSync(paths.ledger, { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  // Appending to an existing file doesn't change the directory entry, so the
  // parent dir only needs an fsync when events.jsonl is first created (audit
  // M3). Avoids a redundant directory fsync on every event append.
  const isNew = !existsSync(paths.events);
  const fd = openSync(paths.events, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isNew) fsyncDir(paths.ledger);
}

/** Append an event while holding the ledger lock (for standalone callers). */
export async function appendEvent(root: string, event: Record<string, unknown>): Promise<void> {
  await withLedgerLock(root, () => appendEventUnlocked(root, event));
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
    retries: { retries: 15, minTimeout: 20, maxTimeout: 400 },
    stale: 60_000,
  });
  try {
    // Sweep under the lock: all writes funnel through here, so any *.tmp
    // present now is genuinely orphaned (a concurrent writer's live temp can
    // never be visible while we hold the lock).
    sweepOrphanTmp(root);
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
    const parsed = ClaimSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      throw new RecordError(
        file,
        `schema: ${parsed.error.issues[0]?.message ?? "invalid claim"}`,
        "schema_invalid",
      );
    }
    claims.push(parsed.data);
  }
  return claims;
}

export function activeClaimForTask(root: string, taskId: string): ClaimRecord | undefined {
  return loadClaims(root).find((c) => c.task === taskId && c.status === "active");
}

/** Load and validate all issue records (permissive schema; spec §6.3). */
export function loadIssues(root?: string): IssueRecord[] {
  const dir = join(ledgerPaths(root).ledger, "issues");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const issues: IssueRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const parsed = IssueSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      throw new RecordError(
        file,
        `schema: ${parsed.error.issues[0]?.message ?? "invalid issue"}`,
        "schema_invalid",
      );
    }
    issues.push(parsed.data);
  }
  return issues;
}
