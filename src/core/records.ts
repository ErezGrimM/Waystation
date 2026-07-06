import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { type TaskRecord, TaskRecord as TaskRecordSchema } from "./schema.ts";

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

/** Read and JSON-parse a file, raising a RecordError on malformed JSON. */
function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new RecordError(file, `cannot read file: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RecordError(file, `invalid JSON: ${(err as Error).message}`);
  }
}

/**
 * Load and validate all JSON task records under `.waystation/tasks/`.
 * zod is the schema authority: every record is validated on read.
 */
export function loadTasks(root?: string): TaskRecord[] {
  const paths = ledgerPaths(root);
  let entries: string[];
  try {
    entries = readdirSync(paths.tasks);
  } catch {
    return [];
  }

  const tasks: TaskRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue; // canonical records are JSON
    const file = join(paths.tasks, name);
    const data = readJson(file);
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
    tasks.push(parsed.data);
  }
  return tasks;
}
