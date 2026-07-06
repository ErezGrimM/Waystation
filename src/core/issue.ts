import { join } from "node:path";
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

function issueFile(root: string, id: string): string {
  return join(ledgerPaths(root).ledger, "issues", `${id}.json`);
}

export async function createIssue(
  root: string,
  input: CreateIssueInput,
  now: Date = new Date(),
): Promise<IssueRecord> {
  return withLedgerLock(root, () => {
    const ts = nowIso(now);
    const id =
      input.id ?? `issue-${safeIdPart(input.title.toLowerCase().slice(0, 40))}-${safeIdPart(ts)}`;

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
    writeJsonAtomic(issueFile(root, id), record);
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
