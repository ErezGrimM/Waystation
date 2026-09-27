/**
 * Portable bounded process adapter for Git read commands (plan §5.1).
 *
 * One adapter serves Bun (Bun.spawnSync) and the supported Node fallback
 * (node:child_process.spawnSync) with argument arrays, no shell, bounded
 * time/output, and structured diagnostics. The existing helpers in git.ts and
 * the dashboard are untouched and are not rerouted through this module.
 */
import { spawnSync } from "node:child_process";

import { type CommandResult, diag, okResult, toResult } from "./result.ts";

export const GIT_DEFAULT_TIMEOUT_MS = 10_000;
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export type GitBackend = "bun" | "node";

export interface GitRunInput {
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  backend?: GitBackend;
}

export interface GitRunOutput {
  backend: GitBackend;
  exitCode: number;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface BackendOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array | null;
  stderr: Uint8Array | null;
  spawnError: string | null;
  timedOut: boolean;
  outputOverflow: boolean;
}

const isBun = typeof Bun !== "undefined";

function mergedEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

function runViaNode(input: GitRunInput, timeoutMs: number, maxOutputBytes: number): BackendOutcome {
  const result = spawnSync("git", input.args, {
    cwd: input.cwd,
    env: mergedEnv(input.env),
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    killSignal: "SIGKILL",
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "spawn_failed";
    return {
      exitCode: result.status,
      signal: result.signal ?? null,
      stdout: null,
      stderr: null,
      spawnError: code === "ETIMEDOUT" || code === "ENOBUFS" ? null : code,
      timedOut: code === "ETIMEDOUT",
      outputOverflow: code === "ENOBUFS",
    };
  }
  const killed = result.status === null && result.signal !== null;
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    stdout,
    stderr,
    spawnError: null,
    timedOut: killed,
    outputOverflow: false,
  };
}

function runViaBun(input: GitRunInput, timeoutMs: number, maxOutputBytes: number): BackendOutcome {
  try {
    const result = Bun.spawnSync(["git", ...input.args], {
      cwd: input.cwd,
      env: mergedEnv(input.env),
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    });
    const killed = result.exitCode === null && result.signalCode !== null;
    return {
      exitCode: result.exitCode,
      signal: result.signalCode ?? null,
      stdout: result.stdout ?? new Uint8Array(0),
      stderr: result.stderr ?? new Uint8Array(0),
      spawnError: null,
      timedOut:
        killed &&
        result.stdout.byteLength <= maxOutputBytes &&
        result.stderr.byteLength <= maxOutputBytes,
      outputOverflow:
        result.stdout.byteLength > maxOutputBytes || result.stderr.byteLength > maxOutputBytes,
    };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "spawn_failed";
    return {
      exitCode: null,
      signal: null,
      stdout: null,
      stderr: null,
      spawnError: code,
      timedOut: false,
      outputOverflow: false,
    };
  }
}

export function runGit(input: GitRunInput): CommandResult<GitRunOutput> {
  const timeoutMs = input.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES;
  const backend: GitBackend = input.backend ?? (isBun ? "bun" : "node");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0
  ) {
    return toResult<GitRunOutput>(null, [
      diag("git_command_failed", {
        message: "Git time and output bounds must be positive safe integers",
      }),
    ]);
  }
  const outcome =
    backend === "bun"
      ? runViaBun(input, timeoutMs, maxOutputBytes)
      : runViaNode(input, timeoutMs, maxOutputBytes);
  const stdoutBytes = outcome.stdout?.byteLength ?? 0;
  const stderrBytes = outcome.stderr?.byteLength ?? 0;
  const overflowed =
    outcome.outputOverflow || stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes;

  if (outcome.spawnError) {
    return toResult<GitRunOutput>(null, [
      diag("git_command_failed", {
        message: `git executable could not be launched (${outcome.spawnError})`,
        details: { backend, args: input.args, cwd: input.cwd, spawnError: outcome.spawnError },
      }),
    ]);
  }
  if (outcome.timedOut) {
    return toResult<GitRunOutput>(null, [
      diag("git_command_failed", {
        message: `git command exceeded the ${timeoutMs}ms time bound and was killed`,
        details: { backend, args: input.args, cwd: input.cwd, timeoutMs },
      }),
    ]);
  }
  if (overflowed) {
    return toResult<GitRunOutput>(null, [
      diag("git_command_failed", {
        message: `git command output exceeded the ${maxOutputBytes}-byte output bound; no output is returned`,
        details: {
          backend,
          args: input.args,
          cwd: input.cwd,
          maxOutputBytes,
          stdoutBytes,
          stderrBytes,
        },
      }),
    ]);
  }
  if (outcome.exitCode === null || !outcome.stdout || !outcome.stderr) {
    return toResult<GitRunOutput>(null, [
      diag("unexpected_error", {
        message: "git process produced no usable exit status",
        details: { backend, args: input.args, cwd: input.cwd },
      }),
    ]);
  }
  return okResult({
    backend,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  });
}
