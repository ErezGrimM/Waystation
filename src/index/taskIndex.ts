import type { TaskRecord, TaskStatus } from "../core/schema.ts";
import { byPriorityThenCreatedAtThenId, type ReadinessTask, taskReadiness } from "../core/tasks.ts";
import { type Db, openDb } from "./db.ts";

/**
 * Build (or rebuild) the task portion of the SQLite index from canonical
 * records. The index is disposable: it is dropped and recreated on every
 * build, so deleting the file and rebuilding always yields equivalent state.
 */
export async function buildTaskIndex(path: string, tasks: TaskRecord[]): Promise<Db> {
  const db = await openDb(path);
  db.exec("DROP TABLE IF EXISTS tasks");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      scope TEXT,
      dependencies TEXT NOT NULL,
      created_at TEXT
    )
  `);
  for (const t of tasks) {
    db.run(
      "INSERT OR REPLACE INTO tasks (id, title, status, priority, scope, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      t.id,
      t.title,
      t.status,
      t.priority,
      t.scope ?? null,
      JSON.stringify(t.dependencies),
      t.created_at ?? null,
    );
  }
  return db;
}

export interface IndexedTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope: string | null;
  created_at: string | null;
}

/** Query ready tasks straight from the index (status + dependency check). */
export function readyFromIndex(db: Db): IndexedTask[] {
  const rows = db.all<{
    id: string;
    title: string;
    status: TaskStatus;
    priority: number;
    scope: string | null;
    dependencies: string;
    created_at: string | null;
  }>("SELECT id, title, status, priority, scope, dependencies, created_at FROM tasks");

  const indexed = rows.map((row) => ({
    ...row,
    dependencies: JSON.parse(row.dependencies) as string[],
  }));
  const byId = new Map<string, ReadinessTask>(indexed.map((task) => [task.id, task]));

  return indexed
    .filter((task) => taskReadiness(task, byId).state === "actionable")
    .sort(byPriorityThenCreatedAtThenId)
    .map(({ id, title, status, priority, scope, created_at }) => ({
      id,
      title,
      status,
      priority,
      scope,
      created_at,
    }));
}
