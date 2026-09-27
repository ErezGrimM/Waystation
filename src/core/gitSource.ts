/**
 * Repository source identity from the canonical Git common directory
 * (plan §5.2, W02c).
 *
 * A source is local provenance: one repository (a main checkout with its
 * linked worktrees, sharing one common directory) is one source. The identity
 * is a deterministic digest of the canonical common-directory location, so
 * separate clones are separate sources even when their remotes match, moving
 * a checkout changes its identity, and remote URLs are never identity and are
 * never persisted. Aliases (junctions, short names, case variants) resolve
 * through platform-aware canonicalization; case-sensitive directories on
 * case-sensitive platforms are never lowercased.
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import type { GitBackend, GitRunOutput } from "./gitProcess.ts";
import { runSafeGit } from "./gitSafe.ts";
import type { CommandResult, Diagnostic } from "./result.ts";
import { diag, okResult, toResult } from "./result.ts";

export interface GitSourceIdentity {
  /** Canonical absolute common directory: junction, short-name and case variants resolved. */
  commonDir: string;
  /** Deterministic identity derived from the canonical common-directory location. */
  sourceId: string;
  /** True when the repository is bare (no working tree). */
  bare: boolean;
}

export interface GetSourceIdentityOptions {
  backend?: GitBackend;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const utf8Decoder = new TextDecoder();

function canonicalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

/**
 * Canonical common-directory form: resolved physical location with forward
 * separators. Native realpath resolves stored casing on Windows without
 * conflating distinct directories on case-sensitive Windows volumes.
 */
function canonicalCommonDir(raw: string): string {
  const resolved = canonicalize(raw);
  const unified = process.platform === "win32" ? resolved.replace(/\\/g, "/") : resolved;
  return unified;
}

/** Derive the deterministic source ID from the canonical common-directory location. */
export function sourceIdFromCommonDir(commonDir: string): string {
  const canonical = canonicalCommonDir(commonDir);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function passThroughDiags(result: CommandResult<GitRunOutput>): CommandResult<GitSourceIdentity> {
  const diags: Diagnostic[] = [...result.errors, ...result.warnings];
  return toResult<GitSourceIdentity>(null, diags);
}

/**
 * Identify one local evidence repository by its canonical Git common
 * directory. Linked worktrees of one repository share the identity; separate
 * clones and moved checkouts do not.
 */
export function getSourceIdentity(
  repo: string,
  options: GetSourceIdentityOptions = {},
): CommandResult<GitSourceIdentity> {
  try {
    if (!statSync(repo).isDirectory()) {
      return toResult<GitSourceIdentity>(null, [
        diag("git_not_repository", {
          message: "the evidence repository path is not a directory",
          details: { repo },
        }),
      ]);
    }
  } catch {
    return toResult<GitSourceIdentity>(null, [
      diag("git_not_repository", {
        message: "the evidence repository path does not exist",
        details: { repo },
      }),
    ]);
  }

  const commonDirRun = runSafeGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repo,
    options,
  );
  if (!commonDirRun.ok || !commonDirRun.data) return passThroughDiags(commonDirRun);
  if (commonDirRun.data.exitCode !== 0) {
    return toResult<GitSourceIdentity>(null, [
      diag("git_not_repository", {
        message: "the evidence path is not a Git repository (bare or working)",
        details: { repo, stderr: utf8Decoder.decode(commonDirRun.data.stderr).trim() },
      }),
    ]);
  }
  const rawCommonDir = utf8Decoder.decode(commonDirRun.data.stdout).trim();
  if (rawCommonDir.length === 0) {
    return toResult<GitSourceIdentity>(null, [
      diag("git_command_failed", {
        message: "git reported an empty common directory",
        details: { repo },
      }),
    ]);
  }

  const bareRun = runSafeGit(["rev-parse", "--is-bare-repository"], repo, options);
  if (!bareRun.ok || !bareRun.data) return passThroughDiags(bareRun);
  if (bareRun.data.exitCode !== 0) {
    return toResult<GitSourceIdentity>(null, [
      diag("git_command_failed", {
        message: "git could not report whether the repository is bare",
        details: { repo, stderr: utf8Decoder.decode(bareRun.data.stderr).trim() },
      }),
    ]);
  }

  let commonDir: string;
  try {
    commonDir = canonicalCommonDir(rawCommonDir);
  } catch {
    return toResult<GitSourceIdentity>(null, [
      diag("git_command_failed", {
        message: "Git common directory cannot be canonicalized",
        details: { repo },
      }),
    ]);
  }
  return okResult({
    commonDir,
    sourceId: createHash("sha256").update(commonDir, "utf8").digest("hex"),
    bare: utf8Decoder.decode(bareRun.data.stdout).trim() === "true",
  });
}
