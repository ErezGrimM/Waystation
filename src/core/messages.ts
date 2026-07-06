import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { RecordError } from "./records.ts";
import { type MessageKind, type MessageRecord, MessageRecord as MessageSchema } from "./schema.ts";
import {
  appendEventUnlocked,
  loadClaims,
  readJsonFile,
  withLedgerLock,
  writeJsonAtomic,
} from "./store.ts";
import { nowIso, safeIdPart } from "./time.ts";

/** Reserved thread id for the folder-wide channel (spec §6.10). */
export const PROJECT_THREAD = "project";

function messageFile(root: string, id: string): string {
  return join(ledgerPaths(root).messages, `${id}.json`);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Seconds-resolution stamp + short suffix so ids are unique per message. */
function messageStamp(d: Date, suffix: string): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${suffix}`
  );
}

/** Load and validate all message records (spec §6.10). */
export function loadMessages(root?: string): MessageRecord[] {
  const dir = ledgerPaths(root).messages;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const messages: MessageRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const parsed = MessageSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      throw new RecordError(
        file,
        `schema: ${parsed.error.issues[0]?.message ?? "invalid message"}`,
        "schema_invalid",
      );
    }
    messages.push(parsed.data);
  }
  return messages;
}

function byCreatedAt(a: MessageRecord, b: MessageRecord): number {
  return a.created_at < b.created_at
    ? -1
    : a.created_at > b.created_at
      ? 1
      : a.id.localeCompare(b.id);
}

export interface PostMessageInput {
  thread: string;
  from: string;
  to?: string | null;
  kind?: MessageKind;
  body: string;
  inReplyTo?: string | null;
}

/** Post an immutable message through the core write path (lock + event). */
export async function postMessage(
  root: string,
  input: PostMessageInput,
  now: Date = new Date(),
  suffix: string = Math.random().toString(36).slice(2, 6),
): Promise<MessageRecord> {
  return withLedgerLock(root, () => {
    const ts = nowIso(now);
    const message: MessageRecord = {
      id: `message-${safeIdPart(input.thread)}-${safeIdPart(input.from)}-${messageStamp(now, suffix)}`,
      thread: input.thread,
      from_agent: input.from,
      to_agent: input.to ?? null,
      kind: input.kind ?? "update",
      body: input.body,
      in_reply_to: input.inReplyTo ?? null,
      created_at: ts,
    };
    const parsed = MessageSchema.parse(message); // fail loudly on a bad message
    writeJsonAtomic(messageFile(root, parsed.id), parsed);
    appendEventUnlocked(root, {
      type: "message.posted",
      message: parsed.id,
      thread: parsed.thread,
      from: parsed.from_agent,
      to: parsed.to_agent,
      actor: parsed.from_agent,
      ts,
    });
    return parsed;
  });
}

/** All messages on a thread, oldest first. */
export function threadMessages(root: string, thread: string): MessageRecord[] {
  return loadMessages(root)
    .filter((m) => m.thread === thread)
    .sort(byCreatedAt);
}

/**
 * An agent's inbox (spec §6.10): messages addressed to it, plus broadcasts
 * (to_agent == null) on the project channel or on a thread it holds an active
 * claim on. Its own messages are excluded. `since` is an ISO cursor.
 */
export function inbox(root: string, agent: string, since?: string): MessageRecord[] {
  const claimedThreads = new Set(
    loadClaims(root)
      .filter((c) => c.agent === agent && c.status === "active")
      .map((c) => c.task),
  );
  return loadMessages(root)
    .filter((m) => {
      // Strictly-before so same-second messages are never skipped (may re-show
      // the boundary second; re-showing is safe, losing is not).
      if (since && Date.parse(m.created_at) < Date.parse(since)) return false;
      if (m.from_agent === agent) return false;
      if (m.to_agent === agent) return true;
      if (m.to_agent == null && (m.thread === PROJECT_THREAD || claimedThreads.has(m.thread))) {
        return true;
      }
      return false;
    })
    .sort(byCreatedAt);
}
