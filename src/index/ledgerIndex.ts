import { type Diagnostic, diag } from "../core/result.ts";
import type { ClaimRecord, IssueRecord, MessageRecord, TaskRecord } from "../core/schema.ts";
import { type Db, openDb, type SqliteBackend } from "./db.ts";

/** A warning if the fallback SQLite backend (node:sqlite) served the query. */
export function backendWarnings(backend: SqliteBackend): Diagnostic[] {
  return backend === "node:sqlite"
    ? [diag("sqlite_backend_fallback", { details: { backend } })]
    : [];
}

export interface LedgerData {
  tasks: TaskRecord[];
  issues: IssueRecord[];
  claims: ClaimRecord[];
  messages: MessageRecord[];
}

export interface IndexCounts {
  tasks: number;
  issues: number;
  claims: number;
  messages: number;
}

const PROJECT_THREAD = "project";

/**
 * Build (or rebuild) the full disposable index from canonical records (spec
 * §9). Every table is dropped and recreated, so deleting the file and
 * rebuilding always yields equivalent state.
 */
export async function buildLedgerIndex(path: string, data: LedgerData): Promise<Db> {
  const db = await openDb(path);
  db.exec("DROP TABLE IF EXISTS tasks");
  db.exec("DROP TABLE IF EXISTS issues");
  db.exec("DROP TABLE IF EXISTS claims");
  db.exec("DROP TABLE IF EXISTS messages");
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, priority INTEGER, scope TEXT, dependencies TEXT)",
  );
  db.exec(
    "CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT, status TEXT, severity TEXT, type TEXT, task TEXT, scope TEXT)",
  );
  db.exec(
    "CREATE TABLE claims (id TEXT PRIMARY KEY, task TEXT, agent TEXT, status TEXT, claimed_at TEXT)",
  );
  db.exec(
    "CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT, from_agent TEXT, to_agent TEXT, kind TEXT, in_reply_to TEXT, created_at TEXT, body TEXT)",
  );

  for (const t of data.tasks) {
    db.run(
      "INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?)",
      t.id,
      t.title,
      t.status,
      t.priority,
      t.scope ?? null,
      JSON.stringify(t.dependencies),
    );
  }
  for (const i of data.issues) {
    db.run(
      "INSERT OR REPLACE INTO issues VALUES (?, ?, ?, ?, ?, ?, ?)",
      i.id,
      i.title,
      i.status,
      i.severity ?? null,
      i.type ?? null,
      i.task ?? null,
      i.scope ?? null,
    );
  }
  for (const c of data.claims) {
    db.run(
      "INSERT OR REPLACE INTO claims VALUES (?, ?, ?, ?, ?)",
      c.id,
      c.task,
      c.agent,
      c.status,
      c.claimed_at,
    );
  }
  for (const m of data.messages) {
    db.run(
      "INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      m.id,
      m.thread,
      m.from_agent,
      m.to_agent ?? null,
      m.kind,
      m.in_reply_to ?? null,
      m.created_at,
      m.body,
    );
  }
  return db;
}

export function counts(data: LedgerData): IndexCounts {
  return {
    tasks: data.tasks.length,
    issues: data.issues.length,
    claims: data.claims.length,
    messages: data.messages.length,
  };
}

export interface IndexedMessage {
  id: string;
  thread: string;
  from_agent: string;
  to_agent: string | null;
  kind: string;
  body: string;
  created_at: string;
}

function selectMessages(db: Db, where: string, ...params: unknown[]): IndexedMessage[] {
  return db.all<IndexedMessage>(
    `SELECT id, thread, from_agent, to_agent, kind, body, created_at FROM messages ${where} ORDER BY created_at, id`,
    ...params,
  );
}

/** A thread's messages, oldest first — served from the index. */
export function threadFromIndex(db: Db, thread: string): IndexedMessage[] {
  return selectMessages(db, "WHERE thread = ?", thread);
}

/**
 * An agent's inbox served entirely from the index: direct messages, plus
 * broadcasts on the project channel or on threads the agent actively claims
 * (read from the claims table). Own messages excluded. `since` is an ISO cursor.
 */
export function inboxFromIndex(db: Db, agent: string, since?: string): IndexedMessage[] {
  const claimed = new Set(
    db
      .all<{ task: string }>("SELECT task FROM claims WHERE agent = ? AND status = 'active'", agent)
      .map((r) => r.task),
  );
  return selectMessages(db, "").filter((m) => {
    if (since && Date.parse(m.created_at) < Date.parse(since)) return false;
    if (m.from_agent === agent) return false;
    if (m.to_agent === agent) return true;
    if (m.to_agent === null && (m.thread === PROJECT_THREAD || claimed.has(m.thread))) return true;
    return false;
  });
}
