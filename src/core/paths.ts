import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** True only if `p` exists and is a directory (a file named .waystation must not count). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class LedgerResolutionError extends Error {
  readonly code = "ledger_not_found";

  constructor(start: string, attempted?: string) {
    super(
      attempted
        ? `no .waystation ledger found at ${attempted}`
        : `no .waystation ledger found from ${resolve(start)} upward`,
    );
    this.name = "LedgerResolutionError";
  }
}

export interface LedgerResolutionOptions {
  /** A root directory containing `.waystation`; takes precedence over all else. */
  explicitRoot?: string;
  /** The invocation location used for discovery and git/worktree context. */
  caller?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the canonical ledger root. Selection is deliberately explicit:
 * `--root`/explicit root, then WAYSTATION_ROOT, then upward discovery from
 * the caller. Unlike the former helper, failure never silently becomes the
 * caller directory.
 */
export function resolveLedgerRoot(options: LedgerResolutionOptions = {}): string {
  const caller = resolve(options.caller ?? process.cwd());
  const configured = options.explicitRoot ?? (options.env ?? process.env).WAYSTATION_ROOT;
  if (configured) {
    const root = resolve(caller, configured);
    if (isDir(join(root, ".waystation"))) return root;
    throw new LedgerResolutionError(caller, root);
  }

  let dir = caller;
  // Walk up to the filesystem root.
  for (;;) {
    if (isDir(join(dir, ".waystation"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new LedgerResolutionError(caller);
    dir = parent;
  }
}

/** @deprecated Use resolveLedgerRoot so absent ledgers are surfaced explicitly. */
export function findProjectRoot(start: string = process.cwd()): string {
  return resolveLedgerRoot({ caller: start });
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

export function ledgerPaths(root: string = resolveLedgerRoot()): LedgerPaths {
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
