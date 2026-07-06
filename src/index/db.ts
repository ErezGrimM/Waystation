/**
 * Thin SQLite adapter over a disposable, rebuildable index (spec §9).
 *
 * The chosen runtime is Bun, so `bun:sqlite` is the primary backend. Node
 * (>=22, `node:sqlite`) is the sanctioned fallback for dev/CI where Bun is not
 * present (see decision-implementation-stack). Both expose synchronous SQLite;
 * this adapter normalizes the small API differences.
 */

export interface Db {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
  close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export async function openDb(path: string): Promise<Db> {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    return {
      exec: (sql) => db.exec(sql),
      all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
      run: (sql, ...params) => {
        db.query(sql).run(...(params as never[]));
      },
      close: () => db.close(),
    };
  }
  // node:sqlite — experimental in Node 22/24 but API-stable enough for a
  // disposable index that only uses positional `?` params and plain SQL.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as never,
    run: (sql, ...params) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}
