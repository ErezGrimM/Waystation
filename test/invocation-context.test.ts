import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInvocationContext, resolveEvidenceSource } from "../src/core/invocationContext.ts";
import { loadTaskById } from "../src/core/records.ts";

const root = mkdtempSync(join(tmpdir(), "waystation-context-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ledger = join(root, "ledger");
const caller = join(root, "caller");
const evidence = join(caller, "evidence");
mkdirSync(join(ledger, ".waystation", "tasks"), { recursive: true });
mkdirSync(evidence, { recursive: true });
expect(Bun.spawnSync(["git", "init", "-q", evidence]).exitCode).toBe(0);

test("ledger, caller and evidence are independent and never change global context", () => {
  const cwd = process.cwd();
  const env = { ...process.env };
  const context = captureInvocationContext({
    explicitRoot: ledger,
    callerDir: caller,
    bindingId: "binding-a",
    env: { WAYSTATION_ROOT: evidence },
  });
  expect(context.ok).toBe(true);
  expect(Object.isFrozen(context.data)).toBe(true);
  expect(context.data?.ledgerRoot).toBe(realpathSync.native(ledger));
  expect(context.data?.bindingId).toBe("binding-a");
  const source = resolveEvidenceSource(context.data!, "evidence");
  expect(source.ok).toBe(true);
  expect(source.data?.repo).toBe(realpathSync.native(evidence));
  expect(resolveEvidenceSource(context.data!).ok).toBe(false);
  expect(process.cwd()).toBe(cwd);
  expect({ ...process.env }).toEqual(env);
});

test("root precedence, upward discovery and failures preserve the existing resolver contract", () => {
  expect(
    captureInvocationContext({ callerDir: caller, env: { WAYSTATION_ROOT: ledger } }).data
      ?.ledgerRoot,
  ).toBe(realpathSync.native(ledger));
  expect(
    captureInvocationContext({ callerDir: join(ledger, ".waystation"), env: {} }).data?.ledgerRoot,
  ).toBe(realpathSync.native(ledger));
  expect(
    captureInvocationContext({
      explicitRoot: "missing",
      callerDir: caller,
      env: { WAYSTATION_ROOT: ledger },
    }).errors[0]?.code,
  ).toBe("ledger_not_found");
  expect(captureInvocationContext({ callerDir: caller, env: {} }).errors[0]?.code).toBe(
    "ledger_not_found",
  );
});

test("headless calls require explicit absolute routes and never use the server cwd", () => {
  expect(captureInvocationContext({ callerDir: null, env: {} }).ok).toBe(false);
  expect(captureInvocationContext({ callerDir: null, explicitRoot: "relative", env: {} }).ok).toBe(
    false,
  );
  const context = captureInvocationContext({ callerDir: null, explicitRoot: ledger });
  expect(context.ok).toBe(true);
  expect(resolveEvidenceSource(context.data!, evidence).ok).toBe(true);
  expect(resolveEvidenceSource(context.data!, "evidence").ok).toBe(false);
  expect(resolveEvidenceSource(context.data!).ok).toBe(false);
});

test("direct task lookup rejects path traversal before reading outside task records", () => {
  writeFileSync(join(ledger, ".waystation", "outside.json"), "invalid json");
  expect(loadTaskById("../outside", ledger)).toBeNull();
  expect(loadTaskById("..\\outside", ledger)).toBeNull();
});
