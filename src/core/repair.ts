import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ledgerPaths } from "./paths.ts";
import { type CommandResult, okResult } from "./result.ts";
import { withLedgerLock } from "./store.ts";

export interface RepairEventsResult {
  /** Absolute path of the repaired file (events.jsonl). */
  file: string;
  /** Physical lines present before repair. */
  originalLines: number;
  /** Lines that were split at }{ boundaries (each holds multiple events). */
  fixedLines: number;
  /** Event lines after repair. */
  finalLines: number;
  /** True when a missing trailing newline was added. */
  newlineFixed: boolean;
  /** True when the file was rewritten. */
  rewritten: boolean;
}

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Byte-level split of a }{-concatenated JSONL line at every }{ boundary
 * (events glued by a writer that appended without a leading newline). Returns
 * null when the line has no boundary or any fragment fails to parse — safety
 * first: never mangle a line that cannot be fully recovered.
 */
function splitConcatenated(line: string): string[] | null {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const boundary = line.indexOf("}{", cursor);
    if (boundary === -1) break;
    parts.push(line.slice(cursor, boundary + 1));
    cursor = boundary + 1;
  }
  if (parts.length === 0) return null;
  parts.push(line.slice(cursor));
  if (parts.some((part) => !isJsonLine(part))) return null;
  return parts;
}

/**
 * Repair events.jsonl: split }{-concatenated lines into one line per event,
 * normalize the file to end with a single trailing newline, and report what
 * was fixed. Runs under the ledger lock so recovered mutation intents append
 * through the same defended path. Idempotent: a clean ledger is untouched.
 */
export async function repairEventsJsonl(root: string): Promise<CommandResult<RepairEventsResult>> {
  return withLedgerLock(root, () => {
    const file = ledgerPaths(root).events;
    if (!existsSync(file)) {
      return okResult({
        file,
        originalLines: 0,
        fixedLines: 0,
        finalLines: 0,
        newlineFixed: false,
        rewritten: false,
      });
    }
    const original = readFileSync(file, "utf8");
    const lines = original.split(/\r?\n/);
    const body = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
    const rebuilt: string[] = [];
    let fixedLines = 0;
    for (const line of body) {
      if (!isJsonLine(line)) {
        const parts = splitConcatenated(line);
        if (parts) {
          rebuilt.push(...parts);
          fixedLines += 1;
          continue;
        }
      }
      rebuilt.push(line);
    }
    const newlineFixed = rebuilt.length > 0 && !original.endsWith("\n");
    const content = `${rebuilt.join("\n")}${rebuilt.length ? "\n" : ""}`;
    const rewritten = content !== original;
    if (rewritten) {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, file);
    }
    return okResult({
      file,
      originalLines: body.length,
      fixedLines,
      finalLines: rebuilt.length,
      newlineFixed,
      rewritten,
    });
  });
}
