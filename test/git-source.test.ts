import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { getSourceIdentity } from "../src/core/gitSource.ts";

const IDENTITY = ["-c", "user.email=w02c@localhost", "-c", "user.name=w02c"];
const backends = ["bun", "node"] as const;
const isWindows = process.platform === "win32";
const FIXTURES_DIR = join(process.cwd(), ".fixtures");

const tmpRoots: string[] = [];

function removeRoot(root: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 40 || !((e as { code?: string }).code ?? "").startsWith("E")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

afterAll(() => {
  for (const root of tmpRoots) removeRoot(root);
});

function scratchRoot(label: string, base: string = tmpdir()): string {
  const root = mkdtempSync(join(base, `waystation-w02c-${label}-`));
  tmpRoots.push(root);
  return root;
}

function git(dir: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString().trim(),
  };
}

function gitOr(dir: string, args: string[]): string {
  const res = git(dir, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.err}`);
  return res.out.trim();
}

function gitFixtureRepoAt(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const res = git(repo, ["init", "-q", "-b", "main", "."]);
  if (res.code !== 0) throw new Error(`git init failed: ${res.err}`);
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitOr(repo, [...IDENTITY, "add", "--", "a.txt"]);
  gitOr(repo, [...IDENTITY, "commit", "-q", "-m", "w02c fixture commit"]);
  return repo;
}

function gitFixtureRepo(label: string, base: string = tmpdir()): string {
  return gitFixtureRepoAt(scratchRoot(label, base));
}

function shortPathOf(repo: string): string | null {
  if (!isWindows) return null;
  const probe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repo.replace(/'/g, "''")}').ShortPath`,
    ],
    { encoding: "utf8" },
  );
  const short = probe.stdout.trim();
  if (probe.status !== 0 || short.length === 0 || short === repo) return null;
  return short;
}

describe("getSourceIdentity (W02c)", () => {
  test("linked worktrees of one repository share one source ID", () => {
    const root = scratchRoot("linked");
    const main = gitFixtureRepoAt(root);
    const linked = join(root, "linked-wt");
    const res = git(main, ["worktree", "add", "-q", linked, "-b", "wtb"]);
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.err}`);
    for (const backend of backends) {
      const mainIdentity = getSourceIdentity(main, { backend });
      const linkedIdentity = getSourceIdentity(linked, { backend });
      expect(mainIdentity.ok).toBe(true);
      expect(linkedIdentity.ok).toBe(true);
      expect(mainIdentity.data?.bare).toBe(false);
      expect(linkedIdentity.data?.bare).toBe(false);
      expect(linkedIdentity.data?.sourceId).toBe(mainIdentity.data?.sourceId);
      expect(linkedIdentity.data?.commonDir).toBe(mainIdentity.data?.commonDir);
    }
  });

  test("two clones of the same remote are two sources, and remote URLs never appear", () => {
    const src = gitFixtureRepo("clone-src");
    const remoteUrl = "https://user:secretpw@remote.example.invalid/proj.git";
    const c1 = join(scratchRoot("clone1"), "clone");
    const c2 = join(scratchRoot("clone2"), "clone");
    mkdirSync(c1, { recursive: true });
    mkdirSync(c2, { recursive: true });
    gitOr(src, ["clone", "-q", src, c1]);
    gitOr(src, ["clone", "-q", src, c2]);
    gitOr(c1, ["remote", "set-url", "origin", remoteUrl]);
    gitOr(c2, ["remote", "set-url", "origin", remoteUrl]);
    const i1 = getSourceIdentity(c1);
    const i2 = getSourceIdentity(c2);
    expect(i1.ok).toBe(true);
    expect(i2.ok).toBe(true);
    expect(i1.data?.sourceId).not.toBe(i2.data?.sourceId);
    expect(i1.data?.commonDir).not.toBe(i2.data?.commonDir);
    const rendered = JSON.stringify([i1.data, i2.data]);
    expect(rendered).not.toContain("secretpw");
    expect(rendered).not.toContain("remote.example.invalid");
  });

  test("moving a checkout changes its identity while recorded associations stay intact", () => {
    const root = scratchRoot("moving");
    const repo = gitFixtureRepoAt(root);
    const moved = join(root, "repo-moved");
    const associationsPath = join(root, "associations.json");
    const original = getSourceIdentity(repo);
    expect(original.ok).toBe(true);
    writeFileSync(associationsPath, JSON.stringify([original.data], null, 2));
    renameSync(repo, moved);
    const movedIdentity = getSourceIdentity(moved);
    expect(movedIdentity.ok).toBe(true);
    expect(movedIdentity.data?.sourceId).not.toBe(original.data?.sourceId);
    expect(movedIdentity.data?.commonDir).not.toBe(original.data?.commonDir);
    // The recorded association keeps its original source ID.
    const recorded = JSON.parse(readFileSync(associationsPath, "utf8")) as {
      sourceId?: string;
    }[];
    expect(recorded[0]?.sourceId).toBe(original.data?.sourceId);
    // Verification at the new location is recorded as a new association.
    recorded.push({ sourceId: movedIdentity.data?.sourceId });
    writeFileSync(associationsPath, JSON.stringify(recorded, null, 2));
    // Moving back restores the original location identity.
    renameSync(moved, repo);
    const restored = getSourceIdentity(repo);
    expect(restored.ok).toBe(true);
    expect(restored.data?.sourceId).toBe(original.data?.sourceId);
  });

  test("alias, junction, short-name and Windows case variants produce one source ID", () => {
    // One repository placed inside the project's excluded .fixtures directory so
    // a cwd-relative alias path never needs to escape the caller directory.
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const root = scratchRoot("alias", FIXTURES_DIR);
    const repo = gitFixtureRepoAt(root);
    const baseline = getSourceIdentity(repo);
    expect(baseline.ok).toBe(true);

    // Relative-path alias, resolved against the caller.
    const relativeRepo = relative(process.cwd(), repo);
    expect(relativeRepo.startsWith("..")).toBe(false);
    const viaRelative = getSourceIdentity(relativeRepo);
    expect(viaRelative.ok).toBe(true);
    expect(viaRelative.data?.sourceId).toBe(baseline.data?.sourceId);
    expect(viaRelative.data?.commonDir).toBe(baseline.data?.commonDir);

    if (isWindows) {
      // Case variant of the same path.
      const caseVariant = repo.toLowerCase();
      const viaCase = getSourceIdentity(caseVariant);
      expect(viaCase.ok).toBe(true);
      expect(viaCase.data?.sourceId).toBe(baseline.data?.sourceId);

      // Junction alias inside the same fixture root.
      const junction = join(root, "junction-link");
      symlinkSync(repo, junction, "junction");
      const viaJunction = getSourceIdentity(junction);
      expect(viaJunction.ok).toBe(true);
      expect(viaJunction.data?.sourceId).toBe(baseline.data?.sourceId);
      expect(viaJunction.data?.commonDir).toBe(baseline.data?.commonDir);

      // 8.3 short-name alias, when the volume generates one.
      const short = shortPathOf(repo);
      if (short !== null) {
        const viaShort = getSourceIdentity(short);
        expect(viaShort.ok).toBe(true);
        expect(viaShort.data?.sourceId).toBe(baseline.data?.sourceId);
        expect(viaShort.data?.commonDir).toBe(baseline.data?.commonDir);
      }
    } else {
      // Symlink alias on case-sensitive platforms.
      const link = join(root, "symlink-link");
      symlinkSync(repo, link);
      const viaSymlink = getSourceIdentity(link);
      expect(viaSymlink.ok).toBe(true);
      expect(viaSymlink.data?.sourceId).toBe(baseline.data?.sourceId);
    }
  });

  test("bare repositories identify from the repository directory", () => {
    const src = gitFixtureRepo("bare-src");
    const bare = join(scratchRoot("bare-dst"), "bare.git");
    gitOr(src, ["clone", "-q", "--bare", src, bare]);
    const identity = getSourceIdentity(bare);
    const sourceIdentity = getSourceIdentity(src);
    expect(identity.ok).toBe(true);
    expect(identity.data?.bare).toBe(true);
    expect(sourceIdentity.data?.bare).toBe(false);
    expect(identity.data?.sourceId).not.toBe(sourceIdentity.data?.sourceId);
    const expectedBare = isWindows ? bare.replace(/\\/g, "/") : bare;
    expect(identity.data?.commonDir).toBe(expectedBare);
  });

  test("a non-repository or missing path is a coded diagnostic", () => {
    const plain = scratchRoot("notrepo");
    const plainRes = getSourceIdentity(plain);
    expect(plainRes.ok).toBe(false);
    expect(plainRes.errors[0]?.code).toBe("git_not_repository");
    const missing = join(scratchRoot("missingdir"), "nope");
    const missingRes = getSourceIdentity(missing);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errors[0]?.code).toBe("git_not_repository");
  });

  const nodeProbe = spawnSync("node", ["--version"], { encoding: "utf8" });
  const nodeMajor = Number.parseInt(nodeProbe.stdout.trim().slice(1), 10);
  const nodeAvailable = !nodeProbe.error && nodeProbe.status === 0 && Number.isFinite(nodeMajor);
  test.skipIf(!nodeAvailable || nodeMajor < 22)(
    "node fallback: identity works under the real node runtime",
    () => {
      const root = scratchRoot("nodereal");
      const repo = gitFixtureRepoAt(root);
      const driverDir = scratchRoot("nodedrv");
      const modulePath = fileURLToPath(new URL("../src/core/gitSource.ts", import.meta.url));
      const driver = join(driverDir, "driver.ts");
      writeFileSync(
        driver,
        [
          'import { pathToFileURL } from "node:url";',
          "const mod = await import(pathToFileURL(process.argv[2] ?? '').href);",
          "const repo = process.argv[3] ?? '.';",
          "const variant = process.argv[4] ?? repo;",
          "const res = mod.getSourceIdentity(variant, { backend: 'node' });",
          "console.log(JSON.stringify({",
          "  ok: res.ok,",
          "  sourceId: res.data === null ? null : res.data.sourceId,",
          "  commonDir: res.data === null ? null : res.data.commonDir,",
          "  bare: res.data === null ? null : res.data.bare,",
          "  errors: res.errors.map((e) => e.code),",
          "}));",
        ].join("\n"),
      );
      const run = (variant: string, flags: string[]) =>
        spawnSync("node", [...flags, driver, modulePath, repo, variant], {
          encoding: "utf8",
          timeout: 60_000,
        });
      const variants = isWindows ? [repo, repo.toLowerCase()] : [repo];
      for (const variant of variants) {
        let out = run(variant, []);
        if (out.status !== 0 && /strip|typescript|experimental/i.test(out.stderr)) {
          out = run(variant, ["--experimental-strip-types"]);
        }
        expect(out.status).toBe(0);
        const parsed = JSON.parse(out.stdout.trim()) as {
          ok: boolean;
          sourceId: string | null;
          commonDir: string | null;
          bare: boolean | null;
          errors: string[];
        };
        const local = getSourceIdentity(variant);
        expect(parsed.ok).toBe(true);
        expect(parsed.errors).toEqual([]);
        expect(parsed.sourceId).toBe(local.data?.sourceId ?? null);
        expect(parsed.commonDir).toBe(local.data?.commonDir ?? null);
        expect(parsed.bare).toBe(local.data?.bare ?? null);
      }
    },
  );
});
