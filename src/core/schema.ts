import { z } from "zod";

/** An ISO-8601-parseable timestamp string (rejects garbage like "yesterday"). */
const isoTs = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO-8601 timestamp" });

const RECORD_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeRecordId(id: string): boolean {
  return RECORD_ID_RE.test(id);
}

export const RecordId = z
  .string()
  .min(1)
  .regex(RECORD_ID_RE, "must be filesystem-safe: [A-Za-z0-9._-], no slashes or '..'");
export type RecordId = z.infer<typeof RecordId>;

export const BriefBudgetValue = z.enum(["small", "medium", "large", "full"]);

export const ProjectConfig = z
  .object({
    defaults: z
      .object({
        brief_budget: BriefBudgetValue.default("medium"),
      })
      .passthrough()
      .default({ brief_budget: "medium" }),
  })
  .passthrough();
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const ProjectOrRecordId = z.union([z.literal("project"), RecordId]);

const COMMIT_REF_RE = /^[A-Fa-f0-9]{7,64}$/;

export function isCommitRef(value: string): boolean {
  return COMMIT_REF_RE.test(value);
}

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
  id: RecordId,
  title: z.string().min(1),
  status: TaskStatus,
  priority: z.number().int().nonnegative().default(3),
  scope: RecordId.nullable().optional(),
  path_hints: z.array(z.string()).default([]),
  prompts: z.array(RecordId).default([]),
  dependencies: z.array(RecordId).default([]),
  created_at: isoTs.optional(),
  updated_at: isoTs.optional(),
  closed_at: isoTs.nullable().optional(),
  description: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
  commits: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

/**
 * Issue record schema (spec §6.3), permissive: only the fields the index and
 * reports need are modeled; extra fields are tolerated (stripped on read).
 */
export const IssueRecord = z
  .object({
    id: RecordId,
    title: z.string().min(1),
    status: z.string().min(1),
    severity: z.string().optional(),
    type: z.string().optional(),
    task: RecordId.nullable().optional(),
    scope: RecordId.nullable().optional(),
    priority: z.number().int().nonnegative().optional(),
    description: z.string().optional(),
    evidence: z.unknown().optional(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    acceptance: z.array(z.string()).optional(),
    resolution: z.string().optional(),
    notes: z.string().optional(),
    source: z.unknown().optional(),
    created_at: isoTs.optional(),
    updated_at: isoTs.optional(),
    closed_at: isoTs.nullable().optional(),
  })
  .passthrough();
export type IssueRecord = z.infer<typeof IssueRecord>;

/** Handoff record schema (spec §6.7): a one-shot baton pass between agents. */
export const HandoffRecord = z.object({
  id: RecordId,
  task: RecordId,
  from_agent: z.string().min(1),
  to_agent: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  worktree: z.string().nullable().optional(),
  created_at: isoTs,
  summary: z.string().optional(),
  changed_files: z.array(z.string()).default([]),
  tests: z.array(z.object({ command: z.string(), status: z.string() })).default([]),
  unfinished: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
});
export type HandoffRecord = z.infer<typeof HandoffRecord>;

/** Message kind values (spec §6.10). */
export const MessageKind = z.enum(["update", "question", "verdict", "note"]);
export type MessageKind = z.infer<typeof MessageKind>;

/**
 * Message record schema (spec §6.10). Append-only, immutable async inbox
 * entry. `thread` is a task/issue id OR the reserved `project` channel.
 */
export const MessageRecord = z.object({
  id: RecordId,
  thread: ProjectOrRecordId,
  from_agent: z.string().min(1),
  to_agent: z.string().nullable().optional(),
  kind: MessageKind.default("update"),
  body: z.string(),
  in_reply_to: RecordId.nullable().optional(),
  created_at: isoTs,
});
export type MessageRecord = z.infer<typeof MessageRecord>;

/** Prompt status values (spec §6.4). */
export const PromptStatus = z.enum(["draft", "active", "deprecated", "archived"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

/** Prompt record schema (spec §6.4): reusable, scoped instruction records. */
export const PromptRecord = z.object({
  id: RecordId,
  title: z.string().min(1),
  version: z.number().int().default(1),
  status: PromptStatus.default("active"),
  applies_to: z
    .object({
      agents: z.array(z.string()).default([]),
      roles: z.array(z.string()).default([]),
      scopes: z.array(RecordId).default([]),
      tasks: z.array(RecordId).default([]),
    })
    .default({ agents: [], roles: [], scopes: [], tasks: [] }),
  priority: z.number().int().default(50),
  purpose: z.string().optional(),
  instructions: z.string().optional(),
  must_do: z.array(z.string()).default([]),
  must_not: z.array(z.string()).default([]),
  commands: z.record(z.string(), z.array(z.string())).optional(),
});
export type PromptRecord = z.infer<typeof PromptRecord>;

/** Claim status values (spec §6.6). */
export const ClaimStatus = z.enum(["active", "released", "completed", "stale"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Claim record schema (spec §6.6). Claims track who is working on what. */
export const ClaimRecord = z.object({
  id: RecordId,
  task: RecordId,
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
