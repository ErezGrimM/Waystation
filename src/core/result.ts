/**
 * Structured error/diagnostic model (see docs/error-philosophy.md).
 *
 * Every command returns a CommandResult with `errors` and `warnings` ARRAYS.
 * Each Diagnostic carries a stable `code`, a template `message`, structured
 * `details` (never string-concatenated into the message), an optional `hint`,
 * and `retryable` — set at the code/class level only, never a context-faked
 * verdict. `code` is the contract; the catalog below is the single source of
 * truth for severity/hint/retryable.
 */

export interface Diagnostic {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
  retryable: boolean;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  data: T | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

type Severity = "error" | "warning";

interface CodeSpec {
  severity: Severity;
  /** Default human message (template). Callers may override with specifics. */
  message: string;
  hint?: string;
  /** Could the SAME input ever succeed on retry? Class-level fact only. */
  retryable: boolean;
}

/** The code catalog. `code` values are stable, lower_snake_case contracts. */
export const CODES = {
  // validation (§18)
  invalid_json: {
    severity: "error",
    message: "Invalid JSON in a record file.",
    hint: "Fix the JSON syntax, then retry.",
    retryable: false,
  },
  schema_invalid: {
    severity: "error",
    message: "Record does not match its schema.",
    hint: "Correct the flagged field to match the record schema.",
    retryable: false,
  },
  duplicate_id: {
    severity: "error",
    message: "Duplicate record id.",
    hint: "Ids must be unique; rename one record.",
    retryable: false,
  },
  missing_dependency: {
    severity: "error",
    message: "Task depends on a task that does not exist.",
    hint: "Create the dependency or fix the reference.",
    retryable: false,
  },
  cycle: {
    severity: "error",
    message: "Circular task dependency.",
    hint: "Break the dependency cycle.",
    retryable: false,
  },
  claim_orphan: {
    severity: "error",
    message: "Claim references a task that does not exist.",
    hint: "Remove the claim or restore the task.",
    retryable: false,
  },
  multiple_active_claims: {
    severity: "error",
    message: "Task has more than one active claim.",
    hint: "Release all but one active claim.",
    retryable: false,
  },
  invalid_jsonl: {
    severity: "error",
    message: "Invalid JSON line in the event log.",
    hint: "Fix the offending events.jsonl line.",
    retryable: false,
  },
  missing_scope: {
    severity: "warning",
    message: "Task references a scope that does not exist.",
    hint: "Create the scope or clear the reference.",
    retryable: false,
  },
  missing_prompt: {
    severity: "warning",
    message: "Task references a prompt that does not exist.",
    hint: "Create the prompt or clear the reference.",
    retryable: false,
  },
  dangling_reply: {
    severity: "warning",
    message: "Message replies to a message that does not exist.",
    hint: "The referenced message may have been pruned; check in_reply_to.",
    retryable: false,
  },
  orphan_thread: {
    severity: "warning",
    message: "Message thread is neither `project` nor an existing task/issue.",
    hint: "The thread's task/issue may have been removed or archived.",
    retryable: false,
  },
  // mutation / lookup surface
  no_such_task: {
    severity: "error",
    message: "No such task.",
    hint: "Check the task id (waystation task list).",
    retryable: false,
  },
  task_already_claimed: {
    severity: "error",
    message: "Task already has an active claim.",
    hint: "Release the existing claim, or claim a different task.",
    retryable: false,
  },
  no_active_claim: {
    severity: "error",
    message: "Task has no active claim.",
    hint: "Claim the task before releasing it.",
    retryable: false,
  },
  task_done: {
    severity: "error",
    message: "Task is already done.",
    hint: "No action needed.",
    retryable: false,
  },
  lock_contended: {
    severity: "error",
    message: "Could not acquire the ledger write lock.",
    hint: "Another process holds it; retry shortly.",
    retryable: true,
  },
  unexpected_error: {
    severity: "error",
    message: "An unexpected error occurred.",
    hint: "This is likely a bug; check the message and file an issue.",
    retryable: false,
  },
  already_initialized: {
    severity: "warning",
    message: "A .waystation ledger already exists here.",
    hint: "Use --force to reinitialize, or run from a different directory.",
    retryable: false,
  },
  // degradations
  sqlite_backend_fallback: {
    severity: "warning",
    message: "Used the fallback SQLite backend.",
    hint: "Result is correct; run under Bun for the primary backend.",
    retryable: false,
  },
} as const satisfies Record<string, CodeSpec>;

export type Code = keyof typeof CODES;

/** Build a diagnostic for a catalogued code; message/details are optional overrides. */
export function diag(
  code: Code,
  opts?: { message?: string; details?: Record<string, unknown> },
): Diagnostic {
  const spec = CODES[code];
  const d: Diagnostic = {
    code,
    message: opts?.message ?? spec.message,
    retryable: spec.retryable,
  };
  if (opts?.details) d.details = opts.details;
  if (spec.hint) d.hint = spec.hint;
  return d;
}

export function severityOf(code: Code): Severity {
  return CODES[code].severity;
}

/** Bucket diagnostics into a CommandResult by their catalogued severity. */
export function toResult<T>(data: T | null, diags: Diagnostic[]): CommandResult<T> {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  for (const d of diags) {
    (CODES[d.code as Code]?.severity === "warning" ? warnings : errors).push(d);
  }
  return { ok: errors.length === 0, data: errors.length ? null : data, errors, warnings };
}

export function okResult<T>(data: T, warnings: Diagnostic[] = []): CommandResult<T> {
  return { ok: true, data, errors: [], warnings };
}
