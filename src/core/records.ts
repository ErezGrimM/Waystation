import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { type TaskRecord, TaskRecord as TaskRecordSchema } from "./schema.ts";
import { readJsonFile } from "./store.ts";

export class RecordError extends Error {
  readonly file: string;
  readonly code: string;

  constructor(file: string, message: string, code: string = "invalid_json") {
    super(`${file}: ${message}`);
    this.name = "RecordError";
    this.file = file;
    this.code = code;
  }
}

/** A validated task record together with the absolute file it was loaded from. */
export interface LoadedTask {
  task: TaskRecord;
  file: string;
}

/**
 * Load and validate all JSON task records under `.waystation/tasks/`, keeping
 * the source file path for each. zod is the schema authority: every record is
 * validated on read. Mutations use the file path to write a record back to the
 * exact file it came from, rather than assuming filename === id (audit M7).
 */
export function loadTaskFiles(root?: string): LoadedTask[] {
  const paths = ledgerPaths(root);
  let entries: string[];
  try {
    entries = readdirSync(paths.tasks);
  } catch {
    return [];
  }

  const loaded: LoadedTask[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue; // canonical records are JSON
    const file = join(paths.tasks, name);
    const data = readJsonFile(file);
    const parsed = TaskRecordSchema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "(root)";
      throw new RecordError(
        file,
        `schema: ${where}: ${issue?.message ?? "invalid record"}`,
        "schema_invalid",
      );
    }
    loaded.push({ task: parsed.data, file });
  }
  return loaded;
}

/**
 * Load and validate all JSON task records under `.waystation/tasks/`.
 * zod is the schema authority: every record is validated on read.
 */
export function loadTasks(root?: string): TaskRecord[] {
  return loadTaskFiles(root).map((t) => t.task);
}

/**
 * Load a single task by id without scanning the whole directory. Canonical
 * records are written to `<id>.json` (see createTask), so the record can be
 * read directly. Because a record's id is not *guaranteed* to equal its
 * filename (audit M7 — a hand-edited or renamed file may diverge), a direct
 * hit is only trusted when the parsed record's id matches; any miss falls back
 * to a full scan so behaviour is identical to `loadTasks().find()`.
 */
export function loadTaskById(id: string, root?: string): TaskRecord | null {
  const file = join(ledgerPaths(root).tasks, `${id}.json`);
  if (existsSync(file)) {
    const parsed = TaskRecordSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "(root)";
      throw new RecordError(
        file,
        `schema: ${where}: ${issue?.message ?? "invalid record"}`,
        "schema_invalid",
      );
    }
    if (parsed.data.id === id) return parsed.data;
  }
  // Filename did not carry the record (absent, or id diverged): scan.
  return loadTasks(root).find((t) => t.id === id) ?? null;
}
