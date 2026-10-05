#!/usr/bin/env bun
/**
 * Narrowly allowlisted adapter for reading claim records.
 *
 * This script is spawned as a subprocess by the Hermes plugin's data access
 * layer. It exposes exactly one read: loadClaims from the canonical core.
 * It never writes, mutates, or creates any ledger state.
 *
 * Output: JSON CommandResult<ClaimRecord[]> on stdout.
 * Error: message on stderr, exit code 1.
 */
import { resolveLedgerRoot } from "../../../src/core/paths.ts";
import { loadClaims } from "../../../src/core/store.ts";

const args = process.argv.slice(2);
let root: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--root" && i + 1 < args.length) {
    root = args[i + 1];
    i++;
  }
}

if (!root) {
  process.stderr.write("error: --root is required\n");
  process.exit(1);
}

try {
  const resolvedRoot = resolveLedgerRoot({ explicitRoot: root });
  const claims = loadClaims(resolvedRoot);
  process.stdout.write(
    `${JSON.stringify({ ok: true, data: claims, errors: [], warnings: [] }, null, 2)}\n`,
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
