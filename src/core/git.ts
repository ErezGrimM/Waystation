import { type CommandResult, diag, okResult, toResult } from "./result.ts";

export interface GitStatusFile {
  status: string;
  file: string;
}

export interface GitStatusSummary {
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  files: GitStatusFile[];
}

export interface GitState {
  root: string;
  worktree: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  status: GitStatusSummary;
}

function runGit(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString().trim(),
  };
}

function gitOrError(cwd: string, args: string[]): string {
  const res = runGit(cwd, args);
  if (res.code !== 0) {
    throw new Error(res.err || `git ${args.join(" ")} failed`);
  }
  return res.out.trim();
}

function statusSummary(cwd: string): GitStatusSummary {
  const res = runGit(cwd, ["status", "--porcelain"]);
  if (res.code !== 0) {
    throw new Error(res.err || "git status --porcelain failed");
  }
  const lines = res.out.split(/\r?\n/).filter((line) => line.length > 0);
  const staged = lines.filter((line) => /^[MADRC]/.test(line) || /^[MADRC] [MADRC]/.test(line));
  const unstaged = lines.filter((line) => /^.[MADRC]/.test(line));
  const untracked = lines.filter((line) => line.startsWith("??"));
  return {
    changed: staged.length + unstaged.length,
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
    files: lines.map((line) => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(3),
    })),
  };
}

export function getGitState(cwd: string): CommandResult<GitState> {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    return toResult<GitState>(null, [
      diag("git_not_repository", {
        message: inside.err || "not inside a git worktree",
        details: { cwd },
      }),
    ]);
  }

  try {
    const root = gitOrError(cwd, ["rev-parse", "--show-toplevel"]);
    const branchOut = runGit(cwd, ["branch", "--show-current"]);
    const branchValue = branchOut.out.trim();
    const branch = branchOut.code === 0 && branchValue ? branchValue : null;
    const headOut = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
    const headValue = headOut.out.trim();
    const head = headOut.code === 0 && headValue ? headValue : null;
    return okResult({
      root,
      worktree: root,
      branch,
      detached: branch === null,
      head,
      status: statusSummary(cwd),
    });
  } catch (e) {
    return toResult<GitState>(null, [
      diag("git_command_failed", {
        message: (e as Error).message,
        details: { cwd },
      }),
    ]);
  }
}
