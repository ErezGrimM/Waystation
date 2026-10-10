import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runSafeGit } from "./gitSafe.ts";
import { LedgerRootMode } from "./schema.ts";

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

  constructor(start: string, attempted?: string, reason?: string) {
    super(
      reason ??
        (attempted
          ? `no .waystation ledger found at ${attempted}`
          : `no .waystation ledger found from ${resolve(start)} upward`),
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
 *
 * A discovered ledger whose config declares `git.ledger_root: "main_worktree"`
 * is redirected from a linked Git worktree to the main worktree's ledger, so
 * agents on feature branches share one ledger instead of writing branch-local
 * snapshots (ADR-0010). Explicit roots are never redirected.
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
    if (isDir(join(dir, ".waystation"))) return sharedLedgerRoot(dir, caller);
    const parent = dirname(dir);
    if (parent === dir) throw new LedgerResolutionError(caller);
    dir = parent;
  }
}

function declaresMainWorktreeLedger(root: string, caller: string): boolean {
  let declared: unknown;
  try {
    const config = JSON.parse(readFileSync(join(root, ".waystation", "config.json"), "utf8"));
    declared = config?.git?.ledger_root;
  } catch {
    // An absent or unreadable config keeps checkout-local behavior.
    return false;
  }
  if (declared === undefined) return false;
  const mode = LedgerRootMode.safeParse(declared);
  // A misspelled mode must not silently fall back to the branch-local ledger.
  if (!mode.success) {
    throw new LedgerResolutionError(
      caller,
      undefined,
      `config git.ledger_root must be "checkout" or "main_worktree", got ${JSON.stringify(declared)}`,
    );
  }
  return mode.data === "main_worktree";
}

function gitLine(cwd: string, args: string[]): string | null {
  const res = runSafeGit(args, cwd);
  if (!res.ok || !res.data || res.data.exitCode !== 0) return null;
  return new TextDecoder().decode(res.data.stdout).trim();
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Map a discovered ledger in a linked worktree to the same location in the
 * main worktree when the project opts in. Outside Git, or already in the main
 * worktree, the discovered root is kept. A declared redirect that cannot be
 * honored fails instead of silently using the branch-local snapshot.
 */
function sharedLedgerRoot(discovered: string, caller: string): string {
  if (!declaresMainWorktreeLedger(discovered, caller)) return discovered;
  const top = gitLine(discovered, ["rev-parse", "--show-toplevel"]);
  const list = gitLine(discovered, ["worktree", "list", "--porcelain"]);
  if (!top || !list) return discovered;
  // The first porcelain block is always the main worktree (or the bare repo).
  const all = list.split(/\r?\n/);
  const blank = all.indexOf("");
  const lines = blank === -1 ? all : all.slice(0, blank);
  const main = lines[0]?.startsWith("worktree ") ? lines[0].slice("worktree ".length) : null;
  if (!main || lines.includes("bare")) {
    throw new LedgerResolutionError(
      caller,
      undefined,
      `config declares git.ledger_root=main_worktree but ${discovered} has no main worktree (bare repository); pass --root or set WAYSTATION_ROOT`,
    );
  }
  if (canonical(main) === canonical(top)) return discovered;
  const target = resolve(canonical(main), relative(canonical(top), canonical(discovered)));
  if (!isDir(join(target, ".waystation"))) {
    throw new LedgerResolutionError(
      caller,
      target,
      `config declares git.ledger_root=main_worktree but the main worktree has no ledger at ${target}; pass --root or set WAYSTATION_ROOT`,
    );
  }
  return target;
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
