import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerResolutionError, resolveLedgerRoot } from "../src/core/paths.ts";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

/**
 * A main checkout with a tracked ledger plus one linked worktree, so the
 * worktree carries its own branch-local copy of `.waystation/`.
 */
function repoWithWorktree(ledgerRoot: unknown, ledgerDir = "."): { main: string; linked: string } {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "waystation-shared-ledger-")));
  tmpRoots.push(parent);
  const main = join(parent, "main");
  mkdirSync(join(main, ledgerDir, ".waystation", "tasks"), { recursive: true });
  const config =
    ledgerRoot === undefined ? { version: 1 } : { version: 1, git: { ledger_root: ledgerRoot } };
  writeFileSync(join(main, ledgerDir, ".waystation", "config.json"), JSON.stringify(config));
  git(parent, "init", "-q", "main");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const linked = join(parent, "linked");
  git(main, "worktree", "add", "-q", "-b", "feature", linked);
  return { main, linked };
}

describe("main-worktree ledger redirect", () => {
  test("linked worktree resolves to the main worktree's ledger when declared", () => {
    const { main, linked } = repoWithWorktree("main_worktree");
    const nested = join(linked, "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveLedgerRoot({ caller: nested })).toBe(main);
    expect(resolveLedgerRoot({ caller: main })).toBe(main);
  });

  test("a ledger in a subdirectory maps to the same subdirectory of the main worktree", () => {
    const { main, linked } = repoWithWorktree("main_worktree", "app");
    expect(resolveLedgerRoot({ caller: join(linked, "app") })).toBe(join(main, "app"));
  });

  test("default and explicit checkout mode keep the worktree's own ledger", () => {
    for (const mode of [undefined, "checkout"]) {
      const { linked } = repoWithWorktree(mode);
      expect(resolveLedgerRoot({ caller: linked })).toBe(linked);
    }
  });

  test("--root and WAYSTATION_ROOT are never redirected", () => {
    const { linked } = repoWithWorktree("main_worktree");
    expect(resolveLedgerRoot({ caller: linked, explicitRoot: linked })).toBe(linked);
    expect(resolveLedgerRoot({ caller: linked, env: { WAYSTATION_ROOT: linked } })).toBe(linked);
  });

  test("a declared redirect without a main-worktree ledger fails instead of falling back", () => {
    const { main, linked } = repoWithWorktree("main_worktree");
    rmSync(join(main, ".waystation"), { recursive: true, force: true });
    expect(() => resolveLedgerRoot({ caller: linked })).toThrow(LedgerResolutionError);
    expect(() => resolveLedgerRoot({ caller: linked })).toThrow(/main worktree has no ledger/);
  });

  test("an unknown ledger_root value fails instead of falling back", () => {
    const { linked } = repoWithWorktree("main-worktree");
    expect(() => resolveLedgerRoot({ caller: linked })).toThrow(/git\.ledger_root must be/);
  });

  test("a declared ledger outside Git stays where it was discovered", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waystation-no-git-")));
    tmpRoots.push(root);
    mkdirSync(join(root, ".waystation"), { recursive: true });
    writeFileSync(
      join(root, ".waystation", "config.json"),
      JSON.stringify({ git: { ledger_root: "main_worktree" } }),
    );
    expect(resolveLedgerRoot({ caller: root })).toBe(root);
  });
});
