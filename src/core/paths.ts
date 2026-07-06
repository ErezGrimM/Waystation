import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Find the project root by walking upward from `start` until a `.waystation`
 * directory is found. Falls back to `start` if none is found.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  // Walk up to the filesystem root.
  for (;;) {
    if (existsSync(join(dir, ".waystation"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export interface LedgerPaths {
  root: string;
  ledger: string;
  tasks: string;
  claims: string;
  messages: string;
  events: string;
  index: string;
  config: string;
}

export function ledgerPaths(root: string = findProjectRoot()): LedgerPaths {
  const ledger = join(root, ".waystation");
  return {
    root,
    ledger,
    tasks: join(ledger, "tasks"),
    claims: join(ledger, "claims"),
    messages: join(ledger, "messages"),
    events: join(ledger, "events.jsonl"),
    index: join(ledger, "index.sqlite"),
    config: join(ledger, "config.json"),
  };
}
