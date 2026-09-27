import { isSafeRecordId } from "./schema.ts";

/**
 * Deterministic, tolerant trailer grammar for Waystation commit-message
 * directives (plan §5.3, freeze §2.5).
 *
 * Pure and deterministic: the same message always yields the same result and
 * the behavior never depends on the user's Git trailer configuration. The
 * parser feeds intent selection only; the close decision belongs to the
 * command's explicit close input and never to a marker.
 */

export interface Trailer {
  /** Key exactly as written in the message (e.g. "Waystation-Task"). */
  key: string;
  /** Key folded to ASCII lowercase for Waystation key matching. */
  keyLower: string;
  /** Full value; continuation lines are appended with "\n". */
  value: string;
  /** 1-based line number of the key/value line within the message. */
  line: number;
}

export type TrailerErrorKind =
  | "duplicate_waystation_task"
  | "empty_task_id"
  | "invalid_task_id"
  | "unknown_waystation_key"
  | "waystation_close"
  | "malformed_waystation_directive"
  | "waystation_continuation"
  | "explicit_conflict"
  | "invalid_explicit_task";

export interface TrailerError {
  kind: TrailerErrorKind;
  /** 1-based line within the message; 0 for selection-level errors. */
  line: number;
  key?: string;
  value?: string;
  /** For explicit_conflict: the task selected by the trailer. */
  trailer_task?: string;
}

export interface TrailerBlock {
  trailers: Trailer[];
  /**
   * Exact, case-sensitive Waystation-Task value when exactly one valid
   * directive selects a task; null otherwise.
   */
  task: string | null;
}

export type TrailerParseResult =
  | { status: "no_trailer_block" }
  | { status: "block"; block: TrailerBlock }
  | { status: "error"; errors: TrailerError[] };

export const WAYSTATION_TASK_KEY = "waystation-task";
export const WAYSTATION_CLOSE_KEY = "waystation-close";

/** A trailer-shaped key/value line: an optional indent, a key, ":", a value. */
const TRAILER_LINE_RE = /^(\s*)([A-Za-z0-9][A-Za-z0-9.-]*):[ \t]*(.*)$/;
/** A recognizable Waystation directive prefix: "waystation-…". */
const WAYSTATION_PREFIX_RE = /^waystation-/i;
/** A malformed naked Waystation directive: "waystation" immediately before ":". */
const WAYSTATION_NAKED_RE = /^waystation[ \t]*:/i;

/** ASCII-only case folding (freeze §2.5: keys match with ASCII case-insensitivity). */
export function asciiLower(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : value.charAt(i);
  }
  return out;
}

/** Folded leading token when a line looks like a Waystation directive. */
function waystationPrefixOf(line: string): string | null {
  const trimmed = line.trimStart();
  const lower = asciiLower(trimmed);
  if (WAYSTATION_PREFIX_RE.test(lower) || WAYSTATION_NAKED_RE.test(lower)) {
    const colon = lower.indexOf(":");
    return colon >= 0 ? lower.slice(0, colon) : lower;
  }
  return null;
}

interface IndexedLine {
  text: string;
  number: number;
}

/**
 * Parse the trailer grammar from a commit message (rules 1-9 of plan §5.3).
 * Returns "no_trailer_block" when the message has no final trailer candidate,
 * "block" when a candidate parsed cleanly, or "error" when a candidate
 * contains an invalid Waystation directive.
 */
export function parseCommitTrailers(message: string): TrailerParseResult {
  // Normalize CRLF and lone CR to LF for deterministic line splitting. The
  // stored description is preserved by callers; this is parse-only.
  const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const raw = normalized.split("\n");
  const lines: IndexedLine[] = raw.map((text, i) => ({ text: text.trimEnd(), number: i + 1 }));

  // Rule 1: ignore trailing blank lines.
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.text.trim() === "") end--;
  if (end === 0) return { status: "no_trailer_block" };

  // Locate the final paragraph: the trailing run of non-blank lines.
  let start = end;
  while (start > 0 && lines[start - 1]?.text.trim() !== "") start--;

  // Rule 2/3: a candidate exists only as a final paragraph after a blank
  // separator. A single-paragraph message is a subject and never a trailer
  // block, even when the subject is itself trailer-shaped.
  if (start === 0) return { status: "no_trailer_block" };

  const paragraph = lines.slice(start, end);
  const firstLine = paragraph[0]?.text.trimStart() ?? "";
  const firstIsTrailer = TRAILER_LINE_RE.test(firstLine);
  const firstIsWaystation = waystationPrefixOf(firstLine) !== null;
  if (!firstIsTrailer && !firstIsWaystation) return { status: "no_trailer_block" };

  const trailers: Trailer[] = [];
  const errors: TrailerError[] = [];
  let task: string | null = null;
  let sawTask = false;
  let waystationLine: number | null = null;

  for (const line of paragraph) {
    const m = TRAILER_LINE_RE.exec(line.text);
    if (m !== null) {
      const key = m[2] ?? "";
      const value = (m[3] ?? "").trim();
      const keyLower = asciiLower(key);
      waystationLine = null;

      if (keyLower === WAYSTATION_TASK_KEY) {
        waystationLine = line.number;
        if (sawTask) {
          errors.push({ kind: "duplicate_waystation_task", line: line.number, key, value });
        } else {
          sawTask = true;
          if (value === "") {
            errors.push({ kind: "empty_task_id", line: line.number, key, value });
          } else if (!isSafeRecordId(value)) {
            errors.push({ kind: "invalid_task_id", line: line.number, key, value });
          } else {
            task = value;
          }
        }
        trailers.push({ key, keyLower, value, line: line.number });
      } else if (keyLower === WAYSTATION_CLOSE_KEY) {
        waystationLine = line.number;
        errors.push({ kind: "waystation_close", line: line.number, key, value });
        trailers.push({ key, keyLower, value, line: line.number });
      } else if (keyLower.startsWith("waystation-")) {
        waystationLine = line.number;
        errors.push({ kind: "unknown_waystation_key", line: line.number, key, value });
        trailers.push({ key, keyLower, value, line: line.number });
      } else {
        trailers.push({ key, keyLower, value, line: line.number });
      }
      continue;
    }

    // A recognizable malformed Waystation directive (e.g. "Waystation-Task x"
    // without a colon) keeps the candidate and is an error.
    if (waystationPrefixOf(line.text) !== null) {
      waystationLine = line.number;
      errors.push({ kind: "malformed_waystation_directive", line: line.number, value: line.text });
      continue;
    }

    // Otherwise the line is a continuation of the previous trailer.
    const prev = trailers[trailers.length - 1];
    if (waystationLine !== null) {
      errors.push({
        kind: "waystation_continuation",
        line: line.number,
        key: prev?.key,
        value: line.text,
      });
    } else if (prev !== undefined) {
      prev.value = `${prev.value}\n${line.text}`;
    } else {
      // Cannot normally happen (a candidate starts trailer-shaped), but stay
      // deterministic rather than silently accepting an unparsed line.
      errors.push({ kind: "malformed_waystation_directive", line: line.number, value: line.text });
    }
  }

  if (errors.length > 0) return { status: "error", errors };
  return { status: "block", block: { trailers, task } };
}

export type TaskSelection =
  | { kind: "no_task" }
  | { kind: "task"; task: string; source: "trailer" | "explicit" }
  | {
      kind: "error";
      reason: "invalid_final_block" | "explicit_conflict" | "invalid_explicit_task";
      errors: TrailerError[];
    };

/**
 * Combine a parsed message with an explicit task argument.
 *
 * - A valid task trailer selects the task.
 * - An explicit task argument is allowed only when no trailer exists and must
 *   match exactly (case-sensitive) when both exist.
 * - Explicit selection never bypasses an invalid final block.
 */
export function resolveTaskSelection(
  parse: TrailerParseResult,
  explicitTask: string | null | undefined,
): TaskSelection {
  if (parse.status === "error") {
    return { kind: "error", reason: "invalid_final_block", errors: parse.errors };
  }
  if (parse.status === "block" && parse.block.task !== null) {
    const trailerTask = parse.block.task;
    if (explicitTask !== undefined && explicitTask !== null && explicitTask !== trailerTask) {
      return {
        kind: "error",
        reason: "explicit_conflict",
        errors: [
          { kind: "explicit_conflict", line: 0, value: explicitTask, trailer_task: trailerTask },
        ],
      };
    }
    return { kind: "task", task: trailerTask, source: "trailer" };
  }
  // No trailer-selected task: an explicit task argument may select.
  if (explicitTask === undefined || explicitTask === null || explicitTask.trim() === "") {
    return { kind: "no_task" };
  }
  if (!isSafeRecordId(explicitTask)) {
    return {
      kind: "error",
      reason: "invalid_explicit_task",
      errors: [{ kind: "invalid_explicit_task", line: 0, value: explicitTask }],
    };
  }
  return { kind: "task", task: explicitTask, source: "explicit" };
}
