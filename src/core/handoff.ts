import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MutationError } from "./mutate.ts";
import { ledgerPaths } from "./paths.ts";
import { loadTasks, RecordError } from "./records.ts";
import { type HandoffRecord, HandoffRecord as HandoffSchema } from "./schema.ts";
import { appendEventUnlocked, readJsonFile, withLedgerLock, writeJsonAtomic } from "./store.ts";
import { idStamp, nowIso, safeIdPart } from "./time.ts";

function handoffsDir(root?: string): string {
  return join(ledgerPaths(root).ledger, "handoffs");
}

function handoffFile(root: string, id: string): string {
  return join(handoffsDir(root), `${id}.json`);
}

export interface CreateHandoffInput {
  task: string;
  from: string;
  to?: string | null;
  summary?: string;
  changed_files?: string[];
  unfinished?: string[];
  risks?: string[];
  next_steps?: string[];
  branch?: string | null;
  worktree?: string | null;
}

/** Create a handoff record through the core write path (lock + event). */
export async function createHandoff(
  root: string,
  input: CreateHandoffInput,
  now: Date = new Date(),
): Promise<HandoffRecord> {
  return withLedgerLock(root, () => {
    const task = loadTasks(root).find((t) => t.id === input.task);
    if (!task) throw new MutationError(`no such task: ${input.task}`, "no_such_task");
    const ts = nowIso(now);
    const record = HandoffSchema.parse({
      id: `handoff-${safeIdPart(input.task)}-${safeIdPart(input.from)}-${idStamp(now)}`,
      task: input.task,
      from_agent: input.from,
      to_agent: input.to ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      created_at: ts,
      summary: input.summary,
      changed_files: input.changed_files ?? [],
      unfinished: input.unfinished ?? [],
      risks: input.risks ?? [],
      next_steps: input.next_steps ?? [],
    });
    writeJsonAtomic(handoffFile(root, record.id), record);
    appendEventUnlocked(root, {
      type: "handoff.created",
      task: input.task,
      handoff: record.id,
      from: input.from,
      to: input.to ?? null,
      actor: input.from,
      ts,
    });
    return record;
  });
}

/** Load and validate all handoff records. */
export function loadHandoffs(root?: string): HandoffRecord[] {
  const dir = handoffsDir(root);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const handoffs: HandoffRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const parsed = HandoffSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      throw new RecordError(
        file,
        `schema: ${parsed.error.issues[0]?.message ?? "invalid handoff"}`,
        "schema_invalid",
      );
    }
    handoffs.push(parsed.data);
  }
  return handoffs;
}

export function getHandoff(root: string, id: string): HandoffRecord | undefined {
  return loadHandoffs(root).find((h) => h.id === id);
}
