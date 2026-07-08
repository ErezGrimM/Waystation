import { readdirSync } from "node:fs";
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
