/**
 * Data access layer for the Waystation Hermes plugin.
 *
 * The plugin runs in the Hermes renderer and cannot import Waystation core
 * directly. This module spawns the Waystation CLI (and a narrowly allowlisted
 * claims adapter) as subprocesses to read ledger data.
 *
 * Safety contract:
 * - All subprocess calls use argument arrays (never shell strings).
 * - The ledger root is explicit and fixed by the caller.
 * - Every subprocess has a finite timeout and output limit.
 * - Result shapes are validated; different commands have different envelopes.
 * - No arbitrary command execution: only pre-built argument arrays are used.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "..", "..", "src", "cli", "index.ts");
const CLAIMS_READ_PATH = join(__dirname, "claims-read.ts");

const SUBPROCESS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority: number;
  description?: string;
  acceptance?: string[];
  [key: string]: unknown;
}

export interface ClaimRecord {
  id: string;
  task: string;
  agent: string;
  status: string;
  [key: string]: unknown;
}

export interface MessageRecord {
  id: string;
  thread: string;
  from_agent: string;
  to_agent: string | null;
  kind: string;
  body: string;
  created_at: string;
}

interface CommandResult<T> {
  ok: boolean;
  data: T | null;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

// ─── Error ───────────────────────────────────────────────────────────────────

export class SubprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubprocessError";
  }
}

// ─── Subprocess runner ───────────────────────────────────────────────────────

async function runSubprocess(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (typeof Bun === "undefined") {
    throw new SubprocessError("Bun runtime is not available in this environment");
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, "run", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), SUBPROCESS_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (stdout.length > MAX_OUTPUT_BYTES) {
      throw new SubprocessError("subprocess output exceeds maximum allowed size");
    }

    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── JSON parsing ────────────────────────────────────────────────────────────

function parseJsonOutput<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new SubprocessError("subprocess output is not valid JSON");
  }
}

// ─── CommandResult validator ─────────────────────────────────────────────────

function validateCommandResult<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    throw new SubprocessError(`command failed: ${result.errors[0]?.message ?? "unknown error"}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new SubprocessError("command returned no data");
  }
  return result.data;
}

// ─── Read functions ──────────────────────────────────────────────────────────

/**
 * Read all tasks from the ledger.
 * Uses: waystation task list --root <root> --json
 * Returns: CommandResult<TaskRecord[]> envelope
 */
export async function readTasks(root: string): Promise<TaskRecord[]> {
  const { stdout, stderr, exitCode } = await runSubprocess([
    CLI_PATH,
    "task",
    "list",
    "--root",
    root,
    "--json",
  ]);

  if (exitCode !== 0) {
    throw new SubprocessError(`task list failed: ${stderr.trim()}`);
  }

  const result = parseJsonOutput<CommandResult<TaskRecord[]>>(stdout);
  return validateCommandResult(result);
}

/**
 * Read all claims from the ledger.
 * Uses: claims-read.ts --root <root> (narrowly allowlisted adapter)
 * Returns: CommandResult<ClaimRecord[]> envelope
 */
export async function readClaims(root: string): Promise<ClaimRecord[]> {
  const { stdout, stderr, exitCode } = await runSubprocess([CLAIMS_READ_PATH, "--root", root]);

  if (exitCode !== 0) {
    throw new SubprocessError(`claims read failed: ${stderr.trim()}`);
  }

  const result = parseJsonOutput<CommandResult<ClaimRecord[]>>(stdout);
  return validateCommandResult(result);
}

/**
 * Read messages for a specific thread.
 * Uses: waystation message list --thread <thread> --root <root> --json
 * Returns: raw MessageRecord[] array (NOT wrapped in CommandResult)
 */
export async function readMessages(root: string, thread: string): Promise<MessageRecord[]> {
  const { stdout, stderr, exitCode } = await runSubprocess([
    CLI_PATH,
    "message",
    "list",
    "--thread",
    thread,
    "--root",
    root,
    "--json",
  ]);

  if (exitCode !== 0) {
    throw new SubprocessError(`message list failed: ${stderr.trim()}`);
  }

  // message list --json returns a raw array, not CommandResult
  return parseJsonOutput<MessageRecord[]>(stdout);
}
