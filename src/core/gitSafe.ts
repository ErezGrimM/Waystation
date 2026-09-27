/**
 * Safety-hardened Git read invocations (plan §5.1).
 *
 * Every Git command issued by the verification modules goes through
 * runSafeGit: replacement refs are disabled with the global
 * --no-replace-objects flag, lazy network fetching and interactive prompts
 * are suppressed through the environment, and only bounded plumbing reads are
 * issued, so nothing is fetched, no hook runs, and nothing is written into
 * the evidence repository.
 */
import type { GitBackend, GitRunOutput } from "./gitProcess.ts";
import { runGit } from "./gitProcess.ts";
import type { CommandResult } from "./result.ts";

export interface SafeGitOptions {
  backend?: GitBackend;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Environment that disables interactive prompts and lazy network fetching.
 * GIT_ASKPASS/SSH_ASKPASS are removed (undefined deletes the variable) so no
 * external prompt helper can be spawned.
 */
export function safetyEnv(): Record<string, string | undefined> {
  // A caller's Git shell environment must never redirect an explicitly selected
  // evidence repository or inject command configuration into these reads.
  const cleared = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.toUpperCase().startsWith("GIT_"))
      .map((key) => [key, undefined]),
  );
  return {
    ...cleared,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
  };
}

/**
 * Run one bounded Git plumbing read with replacement refs disabled and
 * network/interaction suppressed. The global --no-replace-objects flag always
 * leads the argument array, so no call can observe replaced object content.
 */
export function runSafeGit(
  args: string[],
  cwd: string,
  options: SafeGitOptions = {},
): CommandResult<GitRunOutput> {
  return runGit({
    args: ["--no-replace-objects", ...args],
    cwd,
    env: safetyEnv(),
    backend: options.backend,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}
