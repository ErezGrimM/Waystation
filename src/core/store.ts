import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { emitMutationEvent } from "./events.ts";
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
 * Delete every `*.tmp` file in the ledger's record directories plus the ledger
 * root and the derived artifact directories. Callers MUST hold the ledger
 * lock: because all writes funnel through the lock, any `*.tmp` present while
 * it is held is genuinely orphaned, never a live writer's in-flight temp
 * (this includes `mutation-intent.json.tmp` in the ledger root and the
 * Markdown temps under reports/, context/, and views/ — audit finding #14).
 */
export function sweepTmpDirs(root: string): void {
  const paths = ledgerPaths(root);
  const dirs = [
    paths.tasks,
    paths.claims,
    paths.messages,
    join(paths.ledger, "issues"),
    join(paths.ledger, "handoffs"),
    // Orphaned mutation-intent.json.<pid>.<counter>.tmp after a crash
    // between temp write and rename lives in the ledger root itself.
    paths.ledger,
    // writeText (generate.ts) leaves <name>.md.<pid>.<counter>.tmp temps in
    // the derived artifact directories.
    join(paths.ledger, "reports"),
    join(paths.ledger, "context"),
    join(paths.ledger, "views"),
    join(paths.ledger, "views", "tasks"),
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
 * True if the file is empty or its last byte is a line terminator (LF or CR).
 * Used to defend appends: a previous writer may have left the file
 * unterminated, and concatenating onto that line corrupts it.
 */
function endsWithNewline(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a || last[0] === 0x0d;
  } finally {
    closeSync(fd);
  }
}

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
    if (!isNew && !endsWithNewline(paths.events)) {
      // The previous writer left the file unterminated; terminate it before
      // appending so the new event never concatenates onto the last line.
      writeSync(fd, "\n");
    }
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isNew) fsyncDir(paths.ledger);
  // Publish to the in-process mutation hub so live surfaces (dashboard SSE)
  // observe mutations from EVERY surface, not just dashboard-origin ones. The
  // hub broadcast is best-effort and must never throw out of the write path.
  emitMutationEvent(event);
}

/** One journaled record write inside a mutation intent. */
export interface MutationIntentWrite {
  path: string;
  value: unknown;
}

/** A single expected event with stable per-event identity (plan §9.2). */
export interface MutationIntentEvent {
  /** Ordinal/event identity within this mutation; stable across replays. */
  id: string;
  payload: Record<string, unknown>;
}

/** Version-2 mutation intent: per-event identity, no batch-level "any event" check. */
export interface MutationIntent {
  version: 2;
  id: string;
  kind: string;
  writes: MutationIntentWrite[];
  events: MutationIntentEvent[];
}

/** Legacy version-1 intent. Recovered only on an exact ordered event prefix. */
export interface MutationIntentV1 {
  version: 1;
  id: string;
  kind: string;
  writes: MutationIntentWrite[];
  events: Array<Record<string, unknown>>;
}

/** Producer-facing constructor input; `events` are the bare payloads in order. */
export interface MutationIntentInput {
  id: string;
  kind: string;
  writes: MutationIntentWrite[];
  events: Array<Record<string, unknown>>;
}

/** Bookkeeping keys stamped onto appended events so recovery can identify them. */
const MUTATION_ID_KEY = "mutation";
const MUTATION_EVENT_KEY = "intent_event";

/**
 * Build a version-2 intent from a producer's bare event payloads. Each event
 * gets a stable ordinal id; recovery matches already-appended events to this
 * sequence by identity and payload, then appends only the exact missing suffix.
 */
export function buildIntent(input: MutationIntentInput): MutationIntent {
  return {
    version: 2,
    id: input.id,
    kind: input.kind,
    writes: input.writes,
    events: input.events.map((payload, index) => ({ id: String(index), payload })),
  };
}

function intentFile(root: string): string {
  return join(ledgerPaths(root).ledger, "mutation-intent.json");
}

/** A coded RecordError for a pending-intent / recovery problem. */
function intentError(file: string, message: string): RecordError {
  return new RecordError(file, message, "mutation_intent_invalid");
}

/** Convert a ledger record filename into a safe journal-relative target. */
export function mutationWrite(root: string, file: string, value: unknown): MutationIntentWrite {
  const ledger = resolve(ledgerPaths(root).ledger);
  const target = resolve(file);
  const path = relative(ledger, target);
  if (
    !path ||
    path.startsWith("..") ||
    path.includes(`..${sep}`) ||
    resolve(ledger, path) !== target
  ) {
    throw new Error(`mutation target is outside the ledger: ${file}`);
  }
  return { path, value };
}

type ParsedIntent = MutationIntent | MutationIntentV1;

function parseIntent(root: string): ParsedIntent | null {
  const file = intentFile(root);
  if (!existsSync(file)) return null;
  const value = readJsonFile(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw intentError(file, "malformed mutation intent");
  }
  const version = (value as { version?: unknown }).version;
  if (version === 1) return parseV1Intent(file, value as Record<string, unknown>);
  if (version === 2) return parseV2Intent(file, value as Record<string, unknown>);
  throw intentError(file, `unknown mutation intent version: ${String(version)}`);
}

function parseV1Intent(file: string, value: Record<string, unknown>): MutationIntentV1 {
  const id = value.id;
  const kind = value.kind;
  const writes = value.writes;
  const events = value.events;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof kind !== "string" ||
    !Array.isArray(writes) ||
    !Array.isArray(events)
  ) {
    throw intentError(file, "malformed mutation intent");
  }
  return { version: 1, id, kind, writes: writes as MutationIntentWrite[], events };
}

function parseV2Intent(file: string, value: Record<string, unknown>): MutationIntent {
  const id = value.id;
  const kind = value.kind;
  const writes = value.writes;
  const events = value.events;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof kind !== "string" ||
    kind.length === 0 ||
    !Array.isArray(writes) ||
    !Array.isArray(events)
  ) {
    throw intentError(file, "malformed mutation intent");
  }
  for (const rawWrite of writes) {
    if (!rawWrite || typeof rawWrite !== "object" || Array.isArray(rawWrite)) {
      throw intentError(file, "malformed mutation intent write entry");
    }
    const write = rawWrite as Record<string, unknown>;
    if (typeof write.path !== "string" || write.path.length === 0 || !("value" in write)) {
      throw intentError(file, "malformed mutation intent write entry");
    }
  }
  const seenEventIds = new Set<string>();
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
      throw intentError(file, "malformed mutation intent event entry");
    }
    const event = rawEvent as Record<string, unknown>;
    const payload = event.payload;
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw intentError(file, "malformed mutation intent event entry");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw intentError(file, "malformed mutation intent event entry");
    }
    if (seenEventIds.has(event.id)) {
      throw intentError(file, `duplicate event identity in mutation intent: ${event.id}`);
    }
    seenEventIds.add(event.id);
  }
  return {
    version: 2,
    id,
    kind,
    writes: writes as MutationIntentWrite[],
    events: events as MutationIntentEvent[],
  };
}

/**
 * Read the already-appended events for `mutationId` from events.jsonl. Returns
 * the trailing suffix of events carrying that mutation id, verifying they form
 * one contiguous suffix (any earlier event with the same id is duplicate or
 * reordered data). A torn/invalid line is a recovery error, never proof of an
 * empty log.
 */
function readMutationEvents(root: string, mutationId: string): Array<Record<string, unknown>> {
  const eventsFile = ledgerPaths(root).events;
  if (!existsSync(eventsFile)) return [];
  const lines = readFileSync(eventsFile, "utf8").split(/\r?\n/);
  const parsed: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new RecordError(
        eventsFile,
        `torn event log line ${i + 1}; repair before recovery`,
        "mutation_intent_invalid",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RecordError(
        eventsFile,
        `invalid event log line ${i + 1}`,
        "mutation_intent_invalid",
      );
    }
    parsed.push(value as Record<string, unknown>);
  }
  const appended: Array<Record<string, unknown>> = [];
  let idx = parsed.length - 1;
  while (idx >= 0 && (parsed[idx] as { mutation?: unknown }).mutation === mutationId) {
    appended.unshift(parsed[idx] as Record<string, unknown>);
    idx--;
  }
  for (let j = 0; j <= idx; j++) {
    if ((parsed[j] as { mutation?: unknown }).mutation === mutationId) {
      throw new RecordError(
        eventsFile,
        "mutation events are not a contiguous suffix",
        "mutation_intent_invalid",
      );
    }
  }
  return appended;
}

/** Remove the recovery bookkeeping keys so payloads can be compared exactly. */
function stripBookkeeping(event: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === MUTATION_ID_KEY || key === MUTATION_EVENT_KEY) continue;
    rest[key] = value;
  }
  return rest;
}

function verifyV1Prefix(
  file: string,
  intent: MutationIntentV1,
  appended: Array<Record<string, unknown>>,
): void {
  if (appended.length > intent.events.length) {
    throw intentError(file, "more appended events than the intent expects");
  }
  for (let i = 0; i < appended.length; i++) {
    const stored = appended[i];
    const expected = intent.events[i];
    if (!stored || !expected) continue;
    // v1 compares repeated identical payloads by position, not set membership.
    if (!isDeepStrictEqual(stripBookkeeping(stored), expected)) {
      throw intentError(file, `event payload conflict at position ${i}`);
    }
  }
}

function verifyV2Prefix(
  file: string,
  intent: MutationIntent,
  appended: Array<Record<string, unknown>>,
): void {
  if (appended.length > intent.events.length) {
    throw intentError(file, "more appended events than the intent expects");
  }
  for (let i = 0; i < appended.length; i++) {
    const stored = appended[i];
    const expected = intent.events[i];
    if (!stored || !expected) continue;
    if (stored[MUTATION_EVENT_KEY] !== expected.id) {
      throw intentError(
        file,
        `event identity mismatch at position ${i}: expected ${expected.id}, found ${String(stored[MUTATION_EVENT_KEY])}`,
      );
    }
    if (!isDeepStrictEqual(stripBookkeeping(stored), expected.payload)) {
      throw intentError(file, `event payload conflict at position ${i} (${expected.id})`);
    }
  }
}

/**
 * Verify a journal-relative target is canonically contained in the ledger,
 * resolving symlinks/junctions so a path that escapes through a link is
 * refused even though its string prefix looks safe (plan §9.2).
 */
function assertLedgerContained(file: string, ledger: string, target: string): void {
  let realLedger: string;
  try {
    realLedger = realpathSync(ledger);
  } catch {
    return; // ledger not materialized; the string check above already passed
  }
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return;
  }
  const rel = relative(realLedger, realExisting);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw intentError(file, `mutation target escapes the ledger: ${target}`);
  }
}

/** Apply a parsed intent while the ledger lock is held. Safe to repeat. */
function recoverIntentUnlocked(root: string, intent: ParsedIntent): void {
  const file = intentFile(root);
  const ledger = resolve(ledgerPaths(root).ledger);

  // Preflight: every write target is a complete, safely-contained record path.
  for (const write of intent.writes) {
    const target = resolve(ledger, write.path);
    if (target === ledger || !target.startsWith(`${ledger}${sep}`)) {
      throw intentError(file, `mutation intent has unsafe target: ${write.path}`);
    }
    assertLedgerContained(file, ledger, target);
  }

  // Preflight: the already-appended events must match an exact ordered prefix
  // before any additional recovery write happens.
  const appended = readMutationEvents(root, intent.id);
  if (intent.version === 2) {
    verifyV2Prefix(file, intent, appended);
  } else {
    verifyV1Prefix(file, intent, appended);
  }

  // Apply the record writes (atomic per-file replacement).
  for (const write of intent.writes) {
    writeJsonAtomic(resolve(ledger, write.path), write.value);
  }

  // Append only the exact missing event suffix.
  for (let i = appended.length; i < intent.events.length; i++) {
    const event = intent.events[i];
    if (!event) continue;
    if (intent.version === 2) {
      const e = event as MutationIntentEvent;
      appendEventUnlocked(root, {
        ...e.payload,
        [MUTATION_ID_KEY]: intent.id,
        [MUTATION_EVENT_KEY]: e.id,
      });
    } else {
      appendEventUnlocked(root, {
        ...(event as Record<string, unknown>),
        [MUTATION_ID_KEY]: intent.id,
      });
    }
  }

  // Remove the intent only after records and events are durably complete.
  unlinkSync(file);
  fsyncDir(ledger);
}

/** Replay an intent while the ledger lock is held. Safe to repeat after any crash. */
export function recoverMutationIntentUnlocked(root: string): void {
  const intent = parseIntent(root);
  if (!intent) return;
  recoverIntentUnlocked(root, intent);
}

/** Persist a replayable multi-file mutation, then apply it to completion. */
export function applyMutationIntentUnlocked(root: string, intent: MutationIntent): void {
  writeJsonAtomic(intentFile(root), intent);
  recoverMutationIntentUnlocked(root);
}

/** Append an event while holding the ledger lock (for standalone callers). */
export async function appendEvent(root: string, event: Record<string, unknown>): Promise<void> {
  await withLedgerLock(root, () => appendEventUnlocked(root, event));
}

/**
 * A coded error for ledger lock acquisition failure. `lock_contended` is
 * retryable by design, and each surface maps it to the catalog entry instead
 * of surfacing the raw lockfile error as `unexpected_error`.
 */
export class LockError extends Error {
  readonly code = "lock_contended";

  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

/**
 * Canonical ledger directory for the lock. Resolving junctions/symlinks means
 * every cooperating reader/writer locks one path for one ledger regardless of
 * the alias it arrived through (plan §9.1). User-facing paths stay as given.
 */
function canonicalLockDir(root: string): string {
  return realpathSync(join(root, ".waystation"));
}

async function acquireLedgerLock(dir: string): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(dir, {
      realpath: false,
      retries: { retries: 15, minTimeout: 20, maxTimeout: 400 },
      stale: 60_000,
    });
  } catch (err) {
    throw new LockError(`could not acquire ledger lock: ${(err as Error).message}`);
  }
}

/** True while a pending mutation intent exists on disk. */
export function hasPendingIntent(root: string): boolean {
  return existsSync(intentFile(root));
}

/**
 * Run a mutation while holding a single ledger-wide write lock (spec §12).
 * The mutation path creates the ledger directory, sweeps orphaned temporaries
 * once per process, and recovers a pending intent before running the callback.
 * The CLI, dashboard, and MCP layers must all funnel writes through here.
 */
export async function withLedgerLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const paths = ledgerPaths(root);
  mkdirSync(paths.ledger, { recursive: true });
  const release = await acquireLedgerLock(canonicalLockDir(root));
  try {
    // Sweep under the lock: all writes funnel through here, so any *.tmp
    // present now is genuinely orphaned (a concurrent writer's live temp can
    // never be visible while we hold the lock).
    sweepOrphanTmp(root);
    recoverMutationIntentUnlocked(root);
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Run a read-only snapshot/detail operation while holding the SAME ledger
 * lock (plan §9.1). This path never creates the ledger directory, sweeps
 * temporaries, recovers an intent, or writes canonical/derived data. A pending
 * intent is refused with a coded diagnostic instead of being recovered. The
 * missing-ledger failure lives in ledger resolution, so the ledger already
 * exists by the time a snapshot/detail read reaches here.
 */
export async function withLedgerReadLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireLedgerLock(canonicalLockDir(root));
  try {
    if (hasPendingIntent(root)) {
      throw intentError(
        intentFile(root),
        "a pending mutation intent blocks read-only access; run a mutation (or repair) first",
      );
    }
    return await fn();
  } finally {
    await release();
  }
}

export function claimFile(root: string, id: string): string {
  return join(ledgerPaths(root).claims, `${id}.json`);
}

/** A validated claim record together with the file it was loaded from. */
export interface LoadedClaim {
  claim: ClaimRecord;
  file: string;
}

/**
 * Load and validate all claim records, keeping the source file path for each
 * so a mutation writes back to the exact file a claim was loaded from (audit
 * M7 / plan §7.3), rather than assuming filename === id.
 */
export function loadClaimFiles(root?: string): LoadedClaim[] {
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
