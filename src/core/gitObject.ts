/**
 * Commit object resolution and byte-faithful message capture (plan §5.1, W02b).
 *
 * Accepts 7 to 64 hexadecimal characters and resolves them exactly once
 * against the repository's actual object format. Symbolic refs, HEAD, branch
 * and tag names, ranges, revision syntax, ambiguous abbreviations, and
 * non-commit objects are rejected with distinct coded diagnostics; annotated
 * tags are never peeled. The resolved object is read once, with replacement
 * refs disabled and no fetch, hook, or write in the evidence repository, and
 * its message is decoded explicitly, keeping original bytes when lossless
 * decoding is impossible.
 */
import { Buffer } from "node:buffer";
import { statSync } from "node:fs";

import type { GitBackend, GitRunOutput } from "./gitProcess.ts";
import { runSafeGit } from "./gitSafe.ts";
import type { CommandResult, Diagnostic } from "./result.ts";
import { diag, okResult, toResult } from "./result.ts";

export const COMMIT_REF_MIN_HEX = 7;
export const COMMIT_REF_MAX_HEX = 64;

const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{7,64}$/;

export type GitObjectFormat = "sha1" | "sha256";

export interface CommitMessage {
  /** Decoded full message; replacement characters may appear when decoding was not lossless. */
  message: string;
  /** Encoding declared by the commit's `encoding` header, when present. */
  encoding: string | null;
  /** Exact original bytes, retained when lossless decoding was impossible. */
  rawMessageBase64: string | null;
  /** True only when `message` decodes back to the original bytes without loss. */
  decodedLosslessly: boolean;
}

export interface ResolvedCommit {
  /** Full lowercase object id. Only this form is ever persisted. */
  oid: string;
  /** The original reference input, exactly as supplied. */
  alias: string;
  /** The repository's actual object format. */
  objectFormat: GitObjectFormat;
  /** Full lowercase parent object ids, in stored order. */
  parents: string[];
  parentCount: number;
  message: CommitMessage;
  /** Source checkout toplevel; null for a bare repository. */
  sourceWorktree: string | null;
  /** Observational: HEAD's full lowercase oid at resolution time, when available. */
  head: string | null;
  /** Observational: current branch name at resolution time; null when detached or unborn. */
  branch: string | null;
}

export interface ResolveCommitOptions {
  /** Evidence repository path (worktree, subdirectory, or bare repository). */
  repo: string;
  backend?: GitBackend;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const utf8Decoder = new TextDecoder();
const latin1Decoder = new TextDecoder("latin1");

interface ParsedCommitObject {
  parents: string[];
  encoding: string | null;
  messageBytes: Uint8Array;
}

function stdoutText(out: GitRunOutput): string {
  return utf8Decoder.decode(out.stdout);
}

function stderrText(out: GitRunOutput): string {
  return utf8Decoder.decode(out.stderr).trim();
}

function invalidRef(
  reason: string,
  message: string,
  details: Record<string, unknown>,
): CommandResult<ResolvedCommit> {
  return toResult<ResolvedCommit>(null, [
    diag("invalid_commit_ref", { message, details: { ...details, reason } }),
  ]);
}

function passThroughDiags(result: CommandResult<GitRunOutput>): CommandResult<ResolvedCommit> {
  const diags: Diagnostic[] = [...result.errors, ...result.warnings];
  return toResult<ResolvedCommit>(null, diags);
}

/** Locate the first blank line separating the commit header block from the message. */
function findHeaderSeparator(raw: Uint8Array): number {
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) return i;
  }
  return -1;
}

function parseCommitObject(raw: Uint8Array): ParsedCommitObject | null {
  const sep = findHeaderSeparator(raw);
  if (sep < 0) return null;
  const headerBlock = latin1Decoder.decode(raw.subarray(0, sep));
  const parents: string[] = [];
  let encoding: string | null = null;
  for (const line of headerBlock.split("\n")) {
    if (line.startsWith("parent ")) {
      const oid = line.slice("parent ".length).trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(oid) || /^[0-9a-f]{64}$/.test(oid)) parents.push(oid);
    } else if (line.startsWith("encoding ")) {
      encoding = line.slice("encoding ".length).trim() || null;
    }
  }
  return { parents, encoding, messageBytes: raw.subarray(sep + 2) };
}

/**
 * Decode the message explicitly: the declared encoding (if any) is tried
 * first, then UTF-8, both in strict mode. When neither decodes losslessly,
 * the original bytes and encoding metadata are retained and `message` carries
 * only a best-effort replacement-character decoding.
 */
function decodeCommitMessage(bytes: Uint8Array, declared: string | null): CommitMessage {
  const labels = declared ? [declared, "utf-8"] : ["utf-8"];
  for (const label of labels) {
    let strict: TextDecoder;
    try {
      strict = new TextDecoder(label, { fatal: true });
    } catch {
      continue;
    }
    try {
      return {
        message: strict.decode(bytes),
        encoding: declared,
        rawMessageBase64: null,
        decodedLosslessly: true,
      };
    } catch {
      // Not losslessly decodable with this label; try the next.
    }
  }
  return {
    message: utf8Decoder.decode(bytes),
    encoding: declared,
    rawMessageBase64: Buffer.from(bytes).toString("base64"),
    decodedLosslessly: false,
  };
}

function observationText(result: CommandResult<GitRunOutput>): string | null {
  if (!result.ok || !result.data || result.data.exitCode !== 0) return null;
  const text = stdoutText(result.data).trim();
  return text.length > 0 ? text : null;
}

/**
 * Resolve one hexadecimal commit reference against the repository's actual
 * object format and read that exact object once. Bounds violations produce
 * coded diagnostics, never a truncated message or a partially verified object.
 */
export function resolveCommitObject(
  ref: string,
  options: ResolveCommitOptions,
): CommandResult<ResolvedCommit> {
  const { repo } = options;
  if (!COMMIT_REF_PATTERN.test(ref)) {
    return invalidRef(
      "not_hex",
      `"${ref}" is not a valid commit reference: 7 to 64 hexadecimal characters naming one object are required; symbolic refs, HEAD, branch and tag names, ranges, and revision syntax are not accepted`,
      { ref },
    );
  }
  try {
    if (!statSync(repo).isDirectory()) {
      return toResult<ResolvedCommit>(null, [
        diag("git_not_repository", {
          message: "the evidence repository path is not a directory",
          details: { repo },
        }),
      ]);
    }
  } catch {
    return toResult<ResolvedCommit>(null, [
      diag("git_not_repository", {
        message: "the evidence repository path does not exist",
        details: { repo },
      }),
    ]);
  }

  const repoProbe = runSafeGit(["rev-parse", "--git-dir"], repo, options);
  if (!repoProbe.ok || !repoProbe.data) return passThroughDiags(repoProbe);
  if (repoProbe.data.exitCode !== 0) {
    return toResult<ResolvedCommit>(null, [
      diag("git_not_repository", {
        message: "the evidence path is not a Git repository (bare or working)",
        details: { repo, stderr: stderrText(repoProbe.data) },
      }),
    ]);
  }

  const resolution = runSafeGit(["rev-parse", "--verify", ref], repo, options);
  if (!resolution.ok || !resolution.data) return passThroughDiags(resolution);
  if (resolution.data.exitCode !== 0) {
    const stderr = stderrText(resolution.data);
    if (stderr.includes("is ambiguous")) {
      return invalidRef(
        "ambiguous",
        `the abbreviated reference "${ref}" matches more than one object in the repository; supply a longer, unambiguous abbreviation`,
        { ref, repo, stderr },
      );
    }
    return invalidRef(
      "missing",
      `no object matching "${ref}" is available locally; lazy network fetching is disabled, so a missing object is unavailable rather than fetched`,
      { ref, repo, stderr },
    );
  }
  const oid = stdoutText(resolution.data).trim().toLowerCase();
  if (!oid.startsWith(ref.toLowerCase())) {
    return invalidRef(
      "ref_name",
      `"${ref}" resolved as a ref name rather than as the hexadecimal characters of an object id; a commit reference must address the object itself`,
      { ref, repo, resolved: oid },
    );
  }

  const typeProbe = runSafeGit(["cat-file", "-t", oid], repo, options);
  if (!typeProbe.ok || !typeProbe.data) return passThroughDiags(typeProbe);
  if (typeProbe.data.exitCode !== 0) {
    return invalidRef(
      "missing",
      `the object "${oid}" named by "${ref}" is not available locally; lazy network fetching is disabled, so a missing object is unavailable rather than fetched`,
      { ref, repo, oid, stderr: stderrText(typeProbe.data) },
    );
  }
  const objectType = stdoutText(typeProbe.data).trim();
  if (objectType !== "commit") {
    return invalidRef(
      "non_commit",
      `the object "${oid}" is a ${objectType}, not a commit; annotated tags are not peeled to their target commit`,
      { ref, repo, oid, type: objectType },
    );
  }

  const objectRead = runSafeGit(["cat-file", "commit", oid], repo, options);
  if (!objectRead.ok || !objectRead.data) return passThroughDiags(objectRead);
  if (objectRead.data.exitCode !== 0) {
    return toResult<ResolvedCommit>(null, [
      diag("git_command_failed", {
        message: `reading commit object "${oid}" failed`,
        details: { repo, oid, stderr: stderrText(objectRead.data) },
      }),
    ]);
  }
  const parsed = parseCommitObject(objectRead.data.stdout);
  if (!parsed) {
    return toResult<ResolvedCommit>(null, [
      diag("unexpected_error", {
        message: `the commit object "${oid}" is malformed: no header/message separator`,
        details: { repo, oid },
      }),
    ]);
  }

  const formatProbe = runSafeGit(["rev-parse", "--show-object-format"], repo, options);
  const formatText = observationText(formatProbe);
  if (formatText !== "sha1" && formatText !== "sha256") {
    return toResult<ResolvedCommit>(null, [
      diag("unexpected_error", {
        message: `the repository reports an unrecognized object format: ${formatText ?? "(none)"}`,
        details: { repo },
      }),
    ]);
  }

  const toplevel = observationText(runSafeGit(["rev-parse", "--show-toplevel"], repo, options));
  const head = observationText(runSafeGit(["rev-parse", "--verify", "HEAD"], repo, options));

  return okResult({
    oid,
    alias: ref,
    objectFormat: formatText,
    parents: parsed.parents,
    parentCount: parsed.parents.length,
    message: decodeCommitMessage(parsed.messageBytes, parsed.encoding),
    sourceWorktree: toplevel,
    head: head === null ? null : head.toLowerCase(),
    branch: observationText(runSafeGit(["branch", "--show-current"], repo, options)),
  });
}
