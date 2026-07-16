import type { TaskRecord, TaskStatus } from "../core/schema.ts";
import { type ReadinessTask, taskReadiness } from "../core/tasks.ts";
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
      dependencies TEXT NOT NULL
    )
  `);
  for (const t of tasks) {
    db.run(
      "INSERT OR REPLACE INTO tasks (id, title, status, priority, scope, dependencies) VALUES (?, ?, ?, ?, ?, ?)",
      t.id,
      t.title,
      t.status,
      t.priority,
      t.scope ?? null,
      JSON.stringify(t.dependencies),
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
  }>("SELECT id, title, status, priority, scope, dependencies FROM tasks");

  const indexed = rows.map((row) => ({
    ...row,
    dependencies: JSON.parse(row.dependencies) as string[],
  }));
  const byId = new Map<string, ReadinessTask>(indexed.map((task) => [task.id, task]));

  return indexed
    .filter((task) => taskReadiness(task, byId).state === "actionable")
    .sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id),
    )
    .map(({ id, title, status, priority, scope }) => ({ id, title, status, priority, scope }));
}
