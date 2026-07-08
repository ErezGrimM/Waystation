import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { MutationError } from "./mutate.ts";
import { ledgerPaths } from "./paths.ts";
import { type IssueRecord, IssueRecord as IssueSchema } from "./schema.ts";
import { appendEventUnlocked, withLedgerLock, writeJsonAtomic } from "./store.ts";
import { nowIso, safeIdPart } from "./time.ts";

export interface CreateIssueInput {
  id?: string;
  title: string;
  status?: string;
  severity?: string;
  type?: string;
  priority?: number;
  task?: string | null;
  scope?: string | null;
  description?: string;
}

function issueDir(root: string): string {
  return join(ledgerPaths(root).ledger, "issues");
}

function issueFile(root: string, id: string): string {
  const dir = resolve(issueDir(root));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) {
    throw new Error(`invalid issue id: ${id}`);
  }
  const file = resolve(dir, `${id}.json`);
  if (file !== dir && !file.startsWith(`${dir}${sep}`)) {
    throw new Error(`invalid issue id: ${id}`);
  }
  return file;
}

export async function createIssue(
  root: string,
  input: CreateIssueInput,
  now: Date = new Date(),
  suffix: string = Math.random().toString(36).slice(2, 6),
): Promise<IssueRecord> {
  return withLedgerLock(root, () => {
    const ts = nowIso(now);
    // Auto-generated ids get a random suffix so two issues created in the same
    // second (or with the same title) don't collide (audit M9).
    const id =
      input.id ??
      `issue-${safeIdPart(input.title.toLowerCase().slice(0, 40))}-${safeIdPart(ts)}-${suffix}`;

    const file = issueFile(root, id);
    // Never silently overwrite an existing issue. Under the ledger lock this is
    // race-free against other writers (audit M9).
    if (existsSync(file)) {
      throw new MutationError(`issue already exists: ${id}`, "duplicate_id");
    }

    const record: Record<string, unknown> = {
      id,
      title: input.title,
      status: input.status ?? "open",
      created_at: ts,
      updated_at: ts,
      closed_at: null,
    };
    if (input.severity !== undefined) record.severity = input.severity;
    if (input.type !== undefined) record.type = input.type;
    if (input.priority !== undefined) record.priority = input.priority;
    if (input.task !== undefined) record.task = input.task;
    if (input.scope !== undefined) record.scope = input.scope;
    if (input.description !== undefined) record.description = input.description;

    const parsed = IssueSchema.parse(record);
    writeJsonAtomic(file, record);
    appendEventUnlocked(root, {
      type: "issue.created",
      issue: id,
      title: input.title,
      actor: "mcp",
      ts,
    });
    return parsed;
  });
}
