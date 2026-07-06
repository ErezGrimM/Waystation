import { z } from "zod";

/** An ISO-8601-parseable timestamp string (rejects garbage like "yesterday"). */
const isoTs = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO-8601 timestamp" });

/**
 * Task status values (spec §6.2). `claimed` is intentionally NOT a status;
 * claim state is tracked separately.
 */
export const TaskStatus = z.enum([
  "todo",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "wont_do",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Task record schema (spec §6.2). Only the task type is fully modeled in the
 * first walking-skeleton slice; other record types are tightened in
 * task-skeleton-validate.
 */
export const TaskRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatus,
  priority: z.number().int().nonnegative().default(3),
  scope: z.string().nullable().optional(),
  path_hints: z.array(z.string()).default([]),
  prompts: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  created_at: isoTs.optional(),
  updated_at: isoTs.optional(),
  closed_at: isoTs.nullable().optional(),
  description: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

/**
 * Issue record schema (spec §6.3), permissive: only the fields the index and
 * reports need are modeled; extra fields are tolerated (stripped on read).
 */
export const IssueRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  severity: z.string().optional(),
  type: z.string().optional(),
  task: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
});
export type IssueRecord = z.infer<typeof IssueRecord>;

/** Message kind values (spec §6.10). */
export const MessageKind = z.enum(["update", "question", "verdict", "note"]);
export type MessageKind = z.infer<typeof MessageKind>;

/**
 * Message record schema (spec §6.10). Append-only, immutable async inbox
 * entry. `thread` is a task/issue id OR the reserved `project` channel.
 */
export const MessageRecord = z.object({
  id: z.string().min(1),
  thread: z.string().min(1),
  from_agent: z.string().min(1),
  to_agent: z.string().nullable().optional(),
  kind: MessageKind.default("update"),
  body: z.string(),
  in_reply_to: z.string().nullable().optional(),
  created_at: isoTs,
});
export type MessageRecord = z.infer<typeof MessageRecord>;

/** Claim status values (spec §6.6). */
export const ClaimStatus = z.enum(["active", "released", "completed", "stale"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Claim record schema (spec §6.6). Claims track who is working on what. */
export const ClaimRecord = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  agent: z.string().min(1),
  status: ClaimStatus,
  branch: z.string().nullable().optional(),
  worktree: z.string().nullable().optional(),
  claimed_at: isoTs,
  released_at: isoTs.nullable().optional(),
  completed_at: isoTs.nullable().optional(),
  notes: z.string().optional(),
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;
