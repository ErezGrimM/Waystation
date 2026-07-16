import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { MutationError } from "./mutate.ts";
import { ledgerPaths } from "./paths.ts";
import { type IssueRecord, IssueRecord as IssueSchema, isSafeRecordId } from "./schema.ts";
import {
  applyMutationIntentUnlocked,
  mutationWrite,
  readJsonFile,
  withLedgerLock,
} from "./store.ts";
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
  evidence?: string;
  expected?: string;
  actual?: string;
  acceptance?: string[];
  resolution?: string;
  notes?: string;
  source?: unknown;
}
export type UpdateIssueInput = Partial<Omit<CreateIssueInput, "id">>;

function issueDir(root: string): string {
  return join(ledgerPaths(root).ledger, "issues");
}

export async function updateIssue(
  root: string,
  id: string,
  patch: UpdateIssueInput,
  actor = "system",
  now: Date = new Date(),
): Promise<IssueRecord> {
  return withLedgerLock(root, () => {
    const file = issueFile(root, id);
    if (!existsSync(file)) throw new MutationError(`no such issue: ${id}`, "not_found");
    const current = IssueSchema.parse(readJsonFile(file));
    const ts = nowIso(now);
    const updated = IssueSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      created_at: current.created_at,
      closed_at: current.closed_at,
      updated_at: ts,
    });
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-issue-update-${id}-${safeIdPart(ts)}`,
      kind: "issue.update",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "issue.updated", issue: id, actor, ts }],
    });
    return updated;
  });
}

export async function closeIssue(
  root: string,
  id: string,
  resolution: string,
  actor = "system",
  now: Date = new Date(),
): Promise<IssueRecord> {
  return withLedgerLock(root, () => {
    const file = issueFile(root, id);
    if (!existsSync(file)) throw new MutationError(`no such issue: ${id}`, "not_found");
    const current = IssueSchema.parse(readJsonFile(file));
    const ts = nowIso(now);
    const updated = IssueSchema.parse({
      ...current,
      status: "closed",
      resolution,
      updated_at: ts,
      closed_at: ts,
    });
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-issue-close-${id}-${safeIdPart(ts)}`,
      kind: "issue.close",
      writes: [mutationWrite(root, file, updated)],
      events: [{ type: "issue.closed", issue: id, actor, ts }],
    });
    return updated;
  });
}

function issueFile(root: string, id: string): string {
  const dir = resolve(issueDir(root));
  if (!isSafeRecordId(id)) {
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
    if (input.evidence !== undefined) record.evidence = input.evidence;
    if (input.expected !== undefined) record.expected = input.expected;
    if (input.actual !== undefined) record.actual = input.actual;
    if (input.acceptance !== undefined) record.acceptance = input.acceptance;
    if (input.resolution !== undefined) record.resolution = input.resolution;
    if (input.notes !== undefined) record.notes = input.notes;
    if (input.source !== undefined) record.source = input.source;

    const parsed = IssueSchema.parse(record);
    applyMutationIntentUnlocked(root, {
      version: 1,
      id: `mutation-issue-${id}`,
      kind: "issue.create",
      writes: [mutationWrite(root, file, record)],
      events: [{ type: "issue.created", issue: id, title: input.title, actor: "mcp", ts }],
    });
    return parsed;
  });
}
