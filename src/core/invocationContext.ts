import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type GitSourceIdentity, getSourceIdentity } from "./gitSource.ts";
import { LedgerResolutionError, resolveLedgerRoot } from "./paths.ts";
import { type CommandResult, diag, okResult, toResult } from "./result.ts";

/** Captured once per invocation; evidence selection never changes this route. */
export interface InvocationContext {
  readonly ledgerRoot: string;
  readonly callerDir: string | null;
  readonly bindingId: string | null;
}

export interface InvocationOptions {
  explicitRoot?: string;
  /** Omit to capture cwd; null means this transport has no caller directory. */
  callerDir?: string | null;
  bindingId?: string | null;
  env?: Record<string, string | undefined>;
}

export function captureInvocationContext(
  options: InvocationOptions = {},
): CommandResult<InvocationContext> {
  try {
    const env = options.env ?? process.env;
    const caller = options.callerDir === undefined ? process.cwd() : options.callerDir;
    const configured = options.explicitRoot ?? env.WAYSTATION_ROOT;
    if (caller === null && (!configured || !isAbsolute(configured))) {
      return toResult<InvocationContext>(null, [
        diag("ledger_not_found", {
          message: "An absolute ledger root is required when no caller directory is available",
        }),
      ]);
    }
    const callerDir = caller === null ? null : realpathSync.native(resolve(caller));
    const ledgerRoot = realpathSync.native(
      resolveLedgerRoot({
        explicitRoot: options.explicitRoot,
        caller: callerDir ?? configured,
        env,
      }),
    );
    return okResult(Object.freeze({ ledgerRoot, callerDir, bindingId: options.bindingId ?? null }));
  } catch (error) {
    return toResult<InvocationContext>(null, [
      diag("ledger_not_found", {
        message:
          error instanceof LedgerResolutionError
            ? error.message
            : "Cannot resolve the invocation's ledger or caller directory",
      }),
    ]);
  }
}

export interface EvidenceSource {
  readonly repo: string;
  readonly identity: GitSourceIdentity;
}

/** Explicit paths are relative to the captured caller, never to the ledger. */
export function resolveEvidenceSource(
  context: InvocationContext,
  source?: string,
): CommandResult<EvidenceSource> {
  if ((!source || !isAbsolute(source)) && context.callerDir === null) {
    return toResult<EvidenceSource>(null, [
      diag("git_not_repository", {
        message: "An absolute evidence source is required when no caller directory is available",
      }),
    ]);
  }
  try {
    const repo = realpathSync.native(
      source ? resolve(context.callerDir ?? source, source) : (context.callerDir ?? ""),
    );
    const identity = getSourceIdentity(repo);
    if (!identity.ok || !identity.data)
      return toResult<EvidenceSource>(null, [...identity.errors, ...identity.warnings]);
    return okResult(Object.freeze({ repo, identity: identity.data }));
  } catch {
    return toResult<EvidenceSource>(null, [
      diag("git_not_repository", { message: "Cannot resolve the evidence repository directory" }),
    ]);
  }
}
