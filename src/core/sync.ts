import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { IndexCounts } from "../index/ledgerIndex.ts";
import { generateReports, generateTaskViews, reindex } from "./generate.ts";
import { ledgerPaths } from "./paths.ts";
import { type CommandResult, diag, toResult } from "./result.ts";
import { withLedgerLock } from "./store.ts";
import { validateLedger } from "./validate.ts";

export interface SyncOptions {
  projectRoot?: string;
  views?: boolean;
}

export interface SyncSummary {
  index: IndexCounts;
  written: string[];
  task_views: number;
}

const DERIVED_TOP_LEVEL = new Set(["context", "reports", "views"]);

function canonicalFiles(root: string): string[] {
  const ledger = ledgerPaths(root).ledger;
  const files: string[] = [];
  const visit = (dir: string, topLevel: boolean): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (topLevel && DERIVED_TOP_LEVEL.has(name)) continue;
      if (
        name === "index.sqlite" ||
        name.startsWith("index.sqlite-") ||
        name === "mutation-intent.json" ||
        name.endsWith(".tmp")
      ) {
        continue;
      }
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) visit(file, false);
      else if (stat.isFile()) files.push(file);
    }
  };
  visit(ledger, true);
  return files.sort((left, right) => relative(ledger, left).localeCompare(relative(ledger, right)));
}

/** Byte fingerprint of canonical ledger inputs, excluding all derived output. */
export function canonicalFingerprint(root: string): string {
  const ledger = ledgerPaths(root).ledger;
  const hash = createHash("sha256");
  for (const file of canonicalFiles(root)) {
    hash.update(relative(ledger, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Validate, index, render, and project-validate under the ledger mutation lock.
 * A byte fingerprint catches canonical writers that bypass the required lock.
 */
export async function syncLedger(
  root: string,
  options: SyncOptions = {},
): Promise<CommandResult<SyncSummary>> {
  return withLedgerLock(root, async () => {
    const canonical = validateLedger(root);
    if (!canonical.ok) {
      return toResult<SyncSummary>(null, [...canonical.errors, ...canonical.warnings]);
    }

    const before = canonicalFingerprint(root);
    const indexed = await reindex(root);
    if (!indexed.ok || !indexed.data) {
      return toResult<SyncSummary>(null, [...indexed.errors, ...indexed.warnings]);
    }

    const written = generateReports(root);
    const taskViews = options.views ? generateTaskViews(root) : 0;
    if (options.views) written.push(join(ledgerPaths(root).ledger, "views", "tasks"));

    const after = canonicalFingerprint(root);
    if (after !== before) {
      return toResult<SyncSummary>(null, [
        ...indexed.warnings,
        diag("canonical_changed_during_sync", { details: { before, after } }),
      ]);
    }

    const project = validateLedger(root, {
      project: true,
      projectRoot: options.projectRoot ?? root,
      views: options.views,
    });
    return toResult<SyncSummary>({ index: indexed.data, written, task_views: taskViews }, [
      ...indexed.warnings,
      ...project.errors,
      ...project.warnings,
    ]);
  });
}
