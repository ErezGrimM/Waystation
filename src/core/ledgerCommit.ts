/**
 * Attribute uncommitted ledger files to the actors that wrote them, and commit
 * one actor's files without touching the shared checkout.
 *
 * With `git.ledger_root: "main_worktree"` every session writes into one working
 * tree. Each mutation stamps the ledger-relative files it wrote onto its first
 * event (see the intent constructor in store.ts), so the event log says who last wrote each file.
 * `commitLedger` turns that into a commit built from a temporary index and
 * written to a branch ref: HEAD, the real index, and the working tree are
 * never changed, so other sessions are unaffected.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { type CommandResult, type Diagnostic, diag, toResult } from "./result.ts";
import { withLedgerLock } from "./store.ts";

export type LedgerFileCategory = "owned" | "generated" | "unattributed";

export interface LedgerDirtyFile {
  /** Ledger-relative path, forward slashes. */
  path: string;
  state: "modified" | "untracked" | "deleted";
  /** Actor that last wrote the file, from the event log; null if unknown. */
  owner: string | null;
  /** Every actor that wrote the file since the last committed event log, oldest first. */
  owners: string[];
  /** `ledger/*` branches that already hold exactly this content (awaiting merge). */
  onBranches: string[];
  category: LedgerFileCategory;
}

export interface LedgerStatus {
  /** Files not yet on any ledger branch. */
  files: LedgerDirtyFile[];
  /** Every uncommitted file, including those already on a ledger branch. */
  uncommitted: LedgerDirtyFile[];
  /** Each actor's files; a file written by several actors is listed under each. */
  byOwner: Record<string, string[]>;
  generated: string[];
  unattributed: string[];
  /** Files already committed to a `ledger/*` branch and waiting for a merge. */
  pendingMerge: Array<{ path: string; branches: string[] }>;
}

export interface LedgerCommitOptions {
  agent: string;
  /** Target branch; defaults to `ledger/<agent>`. Must not be checked out anywhere. */
  branch?: string;
  message?: string;
  /** Report what would be committed without writing any git objects or refs. */
  dryRun?: boolean;
}

export interface LedgerCommitResult {
  branch: string;
  commit: string | null;
  files: string[];
  /** Files pulled in because a committed task references them. */
  dependencies: string[];
  events: number;
  dryRun: boolean;
}

const GENERATED_PREFIXES = ["reports/", "views/", "context/"];
const SHARED_FILES = new Set(["events.jsonl"]);

/** gitattributes rule that lets concurrent ledger branches merge the append-only event log. */
export const EVENTS_UNION_RULE = ".waystation/events.jsonl merge=union";

/** Add the union-merge rule to the project's .gitattributes; true if the file changed. */
export function ensureUnionMerge(root: string): boolean {
  const file = join(root, ".gitattributes");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes("events.jsonl merge=union")) return false;
  const nl = String.fromCharCode(10);
  const lead = current === "" || current.endsWith(nl) ? "" : nl;
  const comment =
    "# Waystation event log is append-only; ledger branches merge by keeping both sides.";
  writeFileSync(file, `${current}${lead}${comment}${nl}${EVENTS_UNION_RULE}${nl}`);
  return true;
}

class GitFailure extends Error {}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (proc.exitCode !== 0) {
    throw new GitFailure(proc.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.toString();
}

function tryGit(cwd: string, args: string[], env?: Record<string, string>): string | null {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

/**
 * Actors that wrote each ledger file, from `files` stamped on events, oldest
 * first. Only events not yet in HEAD's event log count: those describe the
 * uncommitted state, so a file written by A and then B lists both.
 */
export function ledgerFileOwners(root: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const file = ledgerPaths(root).events;
  if (!existsSync(file)) return owners;
  const ledger = ledgerPaths(root).ledger;
  const prefix = tryGit(ledger, ["rev-parse", "--show-prefix"])?.trim() ?? "";
  const committed = new Set(
    (tryGit(ledger, ["show", `HEAD:${prefix}events.jsonl`]) ?? "").split("\n").filter(Boolean),
  );
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || committed.has(line)) continue;
    try {
      const event = JSON.parse(line) as { actor?: unknown; files?: unknown };
      if (typeof event.actor !== "string" || !Array.isArray(event.files)) continue;
      for (const f of event.files) {
        if (typeof f !== "string") continue;
        const list = (owners.get(f) ?? []).filter((a) => a !== event.actor);
        list.push(event.actor);
        owners.set(f, list);
      }
    } catch {
      // Malformed lines are validate's business, not ownership's.
    }
  }
  return owners;
}

/** Blob ids per `ledger/*` branch, keyed by ledger-relative path. */
function ledgerBranchBlobs(ledger: string, prefix: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const refs = tryGit(ledger, ["for-each-ref", "--format=%(refname:short)", "refs/heads/ledger/"]);
  for (const branch of (refs ?? "").split("\n").filter(Boolean)) {
    const tree = tryGit(ledger, ["ls-tree", "-r", branch, "--", "."]);
    if (tree === null) continue;
    const blobs = new Map<string, string>();
    for (const line of tree.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const sha = line.slice(0, tab).split(" ")[2];
      const path = line.slice(tab + 1);
      // `ls-tree .` prints paths relative to the ledger directory already.
      if (sha) blobs.set(path.startsWith(prefix) ? path.slice(prefix.length) : path, sha);
    }
    out.set(branch, blobs);
  }
  return out;
}

function categorize(path: string, owner: string | null): LedgerFileCategory {
  if (owner) return "owned";
  if (GENERATED_PREFIXES.some((p) => path.startsWith(p))) return "generated";
  return "unattributed";
}

function notARepo<T>(): CommandResult<T> {
  return toResult<T>(null, [
    diag("ledger_not_in_git", { message: "the ledger is not inside a git repository" }),
  ]);
}

/** Uncommitted ledger files grouped by the actor that wrote them. */
export function ledgerStatus(root: string): CommandResult<LedgerStatus> {
  const ledger = ledgerPaths(root).ledger;
  const listed = tryGit(ledger, [
    "ls-files",
    "-z",
    "--modified",
    "--others",
    "--deleted",
    "--exclude-standard",
    "--",
    ".",
  ]);
  if (listed === null) return notARepo<LedgerStatus>();
  const owners = ledgerFileOwners(root);
  const prefix = tryGit(ledger, ["rev-parse", "--show-prefix"])?.trim() ?? "";
  const branchBlobs = ledgerBranchBlobs(ledger, prefix);
  const all: LedgerDirtyFile[] = [];
  const tracked = new Set(
    (tryGit(ledger, ["ls-files", "-z", "--", "."]) ?? "").split("\0").filter(Boolean),
  );
  for (const path of new Set(listed.split("\0").filter(Boolean))) {
    if (SHARED_FILES.has(path)) continue;
    const present = existsSync(join(ledger, path));
    const state = !present ? "deleted" : tracked.has(path) ? "modified" : "untracked";
    const writers = owners.get(path) ?? [];
    const owner = writers.at(-1) ?? null;
    const sha = present ? git(ledger, ["hash-object", "--", join(ledger, path)]).trim() : null;
    const onBranches = [...branchBlobs]
      .filter(([, blobs]) => (sha === null ? !blobs.has(path) : blobs.get(path) === sha))
      .map(([branch]) => branch);
    all.push({
      path,
      state,
      owner,
      owners: writers,
      onBranches,
      category: categorize(path, owner),
    });
  }
  all.sort((a, b) => a.path.localeCompare(b.path));
  const files = all.filter((f) => f.onBranches.length === 0);
  const byOwner: Record<string, string[]> = {};
  for (const f of files) {
    for (const actor of f.owners) {
      const list = byOwner[actor] ?? [];
      list.push(f.path);
      byOwner[actor] = list;
    }
  }
  return toResult(
    {
      files,
      uncommitted: all,
      byOwner,
      generated: files.filter((f) => f.category === "generated").map((f) => f.path),
      unattributed: files.filter((f) => f.category === "unattributed").map((f) => f.path),
      pendingMerge: all
        .filter((f) => f.onBranches.length > 0)
        .map((f) => ({ path: f.path, branches: f.onBranches })),
    },
    [],
  );
}

/** Scope and prompt records that a task file in `owned` references. */
function referencedRecords(ledger: string, owned: string[]): string[] {
  const refs: string[] = [];
  for (const path of owned) {
    if (!path.startsWith("tasks/") || !path.endsWith(".json")) continue;
    try {
      const task = JSON.parse(readFileSync(join(ledger, path), "utf8")) as {
        scope?: unknown;
        prompts?: unknown;
      };
      if (typeof task.scope === "string") refs.push(`scopes/${task.scope}.json`);
      if (Array.isArray(task.prompts))
        for (const p of task.prompts) if (typeof p === "string") refs.push(`prompts/${p}.json`);
    } catch {
      // An unreadable task is reported by validate; skip it here.
    }
  }
  return refs;
}

/**
 * Commit `agent`'s uncommitted ledger files (plus the scope/prompt records its
 * tasks reference) to a branch, without changing HEAD, the index, or the
 * working tree of any checkout.
 */
export async function commitLedger(
  root: string,
  options: LedgerCommitOptions,
): Promise<CommandResult<LedgerCommitResult>> {
  const { agent } = options;
  const branch = options.branch ?? `ledger/${agent}`;
  const ledger = ledgerPaths(root).ledger;
  if (tryGit(ledger, ["rev-parse", "--git-dir"]) === null) {
    return notARepo<LedgerCommitResult>();
  }
  if (tryGit(root, ["check-ref-format", "--branch", branch]) === null) {
    return toResult<LedgerCommitResult>(null, [
      diag("schema_invalid", { message: `invalid branch name: ${branch}` }),
    ]);
  }

  // The exclusive lock serializes concurrent commits (and blocks mutations
  // while files are read); update-ref below also guards against a moved tip.
  return withLedgerLock(root, () => {
    const status = ledgerStatus(root);
    if (!status.ok || !status.data) return status as unknown as CommandResult<LedgerCommitResult>;
    // A file already identical on the target branch has nothing left to commit
    // there, but one that only matches another actor's branch still does.
    const candidates = status.data.uncommitted.filter((f) => !f.onBranches.includes(branch));
    const dirty = new Map(candidates.map((f) => [f.path, f]));
    const mine = candidates.filter((f) => f.owners.includes(agent)).map((f) => f.path);

    const dependencies = referencedRecords(ledger, mine).filter(
      (p) => dirty.has(p) && !mine.includes(p),
    );
    const paths = [...new Set([...mine, ...dependencies])].sort();
    const warnings: Diagnostic[] = [];
    const mergeAttr = tryGit(ledger, ["check-attr", "merge", "--", "events.jsonl"]) ?? "";
    if (!mergeAttr.trim().endsWith(": union")) {
      warnings.push(
        diag("ledger_union_merge_missing", {
          details: { rule: EVENTS_UNION_RULE },
        }),
      );
    }
    for (const path of paths) {
      const others = (dirty.get(path)?.owners ?? []).filter((a) => a !== agent);
      if (others.length > 0) {
        warnings.push(
          diag("ledger_dependency_foreign", {
            message: `${path} was also written by ${others.join(", ")}; the commit holds its current content, including their changes. Merge ${others
              .map((a) => `ledger/${a}`)
              .join(
                ", ",
              )} first, then ${branch}: both branches changed this file, and a conflict there is resolved by keeping the later actor's version`,
            details: { path, owners: others },
          }),
        );
      }
    }

    // Events written by this actor that are not yet committed at the base.
    const eventsFile = ledgerPaths(root).events;
    const checkedOut = new Set<string>();
    for (const line of (tryGit(root, ["worktree", "list", "--porcelain"]) ?? "").split("\n")) {
      if (line.startsWith("branch refs/heads/"))
        checkedOut.add(line.slice("branch refs/heads/".length));
    }
    if (checkedOut.has(branch)) {
      return toResult<LedgerCommitResult>(null, [
        diag("ledger_branch_checked_out", {
          message: `branch ${branch} is checked out in a worktree; choose another with --branch`,
          details: { branch },
        }),
      ]);
    }

    const branchTip = tryGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])?.trim();
    const base = branchTip || git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    const prefix = git(ledger, ["rev-parse", "--show-prefix"]).trim();

    const baseEvents = tryGit(root, ["show", `${base}:${prefix}events.jsonl`]) ?? "";
    const baseLines = new Set(baseEvents.split("\n").filter(Boolean));
    const ownEvents = (existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "")
      .split("\n")
      .filter((line) => {
        if (!line.trim() || baseLines.has(line)) return false;
        try {
          return (JSON.parse(line) as { actor?: unknown }).actor === agent;
        } catch {
          return false;
        }
      });

    if (paths.length === 0 && ownEvents.length === 0) {
      return toResult<LedgerCommitResult>(null, [
        diag("ledger_nothing_to_commit", {
          message: `no uncommitted ledger files are attributed to ${agent}`,
          details: { agent },
        }),
      ]);
    }

    const planned: LedgerCommitResult = {
      branch,
      commit: null,
      files: paths,
      dependencies,
      events: ownEvents.length,
      dryRun: options.dryRun === true,
    };
    if (options.dryRun) return toResult(planned, warnings);

    const tmp = mkdtempSync(join(tmpdir(), "waystation-ledger-commit-"));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, "index") };
      git(root, ["read-tree", base], env);
      for (const path of paths) {
        const target = `${prefix}${path}`;
        if (existsSync(join(ledger, path))) {
          const sha = git(root, ["hash-object", "-w", "--", join(ledger, path)]).trim();
          git(root, ["update-index", "--add", "--cacheinfo", `100644,${sha},${target}`], env);
        } else {
          git(root, ["update-index", "--force-remove", "--", target], env);
        }
      }
      if (ownEvents.length > 0) {
        const merged = `${baseEvents}${baseEvents && !baseEvents.endsWith("\n") ? "\n" : ""}${ownEvents.join("\n")}\n`;
        const eventsPath = join(tmp, "events.jsonl");
        writeFileSync(eventsPath, merged);
        const sha = git(root, ["hash-object", "-w", "--", eventsPath]).trim();
        git(
          root,
          ["update-index", "--add", "--cacheinfo", `100644,${sha},${prefix}events.jsonl`],
          env,
        );
      }
      const tree = git(root, ["write-tree"], env).trim();
      if (tree === git(root, ["rev-parse", `${base}^{tree}`]).trim()) {
        return toResult<LedgerCommitResult>(null, [
          diag("ledger_nothing_to_commit", {
            message: `${agent}'s ledger files already match ${branch}`,
            details: { agent, branch },
          }),
        ]);
      }
      const message =
        options.message ??
        `ledger: ${agent} (${paths.length} file${paths.length === 1 ? "" : "s"})`;
      const commit = git(
        root,
        [
          "-c",
          `user.name=${agent}`,
          "-c",
          "user.email=waystation@localhost",
          "commit-tree",
          tree,
          "-p",
          base,
          "-m",
          message,
        ],
        env,
      ).trim();
      git(root, ["update-ref", `refs/heads/${branch}`, commit, branchTip ?? ""]);
      return toResult({ ...planned, commit }, warnings);
    } catch (error) {
      return toResult<LedgerCommitResult>(null, [
        diag("ledger_commit_failed", { message: (error as Error).message }),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

export interface LedgerSettleOptions {
  /** Only settle files held by this ledger branch; default: any `ledger/*` branch. */
  branch?: string;
  dryRun?: boolean;
}

export interface LedgerSettleResult {
  settled: string[];
  skipped: Array<{ path: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Drop working-tree copies of ledger files whose exact content already lives
 * on a `ledger/*` branch, so merging that branch is not blocked by "local
 * changes would be overwritten". Lossless by construction: a file is touched
 * only if its current bytes match the branch's blob, checked under the lock.
 */
export async function settleLedger(
  root: string,
  options: LedgerSettleOptions = {},
): Promise<CommandResult<LedgerSettleResult>> {
  const ledger = ledgerPaths(root).ledger;
  if (tryGit(ledger, ["rev-parse", "--git-dir"]) === null) {
    return notARepo<LedgerSettleResult>();
  }
  return withLedgerLock(root, () => {
    const status = ledgerStatus(root);
    if (!status.ok || !status.data) return status as unknown as CommandResult<LedgerSettleResult>;
    const targets = status.data.uncommitted.filter((f) =>
      options.branch ? f.onBranches.includes(options.branch) : f.onBranches.length > 0,
    );
    const settled: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const f of targets) {
      if (options.dryRun) {
        settled.push(f.path);
        continue;
      }
      try {
        if (f.state === "untracked") {
          rmSync(join(ledger, f.path), { force: true });
        } else {
          git(ledger, ["checkout", "HEAD", "--", f.path]);
        }
        settled.push(f.path);
      } catch (error) {
        skipped.push({ path: f.path, reason: (error as Error).message });
      }
    }
    // events.jsonl is shared by every actor, so it is only restored once every
    // uncommitted event line is already present on a ledger branch.
    const prefix = git(ledger, ["rev-parse", "--show-prefix"]).trim();
    const eventsFile = ledgerPaths(root).events;
    if (existsSync(eventsFile)) {
      const head = new Set(
        (tryGit(ledger, ["show", `HEAD:${prefix}events.jsonl`]) ?? "").split("\n").filter(Boolean),
      );
      const pending = readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() && !head.has(line));
      const refs = options.branch
        ? [options.branch]
        : (
            tryGit(ledger, ["for-each-ref", "--format=%(refname:short)", "refs/heads/ledger/"]) ??
            ""
          )
            .split("\n")
            .filter(Boolean);
      const onBranches = new Set<string>();
      for (const ref of refs) {
        const text = tryGit(ledger, ["show", `${ref}:${prefix}events.jsonl`]);
        for (const line of (text ?? "").split("\n")) if (line) onBranches.add(line);
      }
      if (pending.length > 0 && pending.every((line) => onBranches.has(line))) {
        try {
          if (!options.dryRun) git(ledger, ["checkout", "HEAD", "--", "events.jsonl"]);
          settled.push("events.jsonl");
        } catch (error) {
          skipped.push({ path: "events.jsonl", reason: (error as Error).message });
        }
      }
    }
    return toResult({ settled, skipped, dryRun: options.dryRun === true }, []);
  });
}
