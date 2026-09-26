import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getGitState } from "../src/core/git.ts";
import { GIT_DEFAULT_MAX_OUTPUT_BYTES, runGit } from "../src/core/gitProcess.ts";

const tmpRoots: string[] = [];

const backends = ["bun", "node"] as const;

const decode = (bytes: Uint8Array | null | undefined): string =>
  Buffer.from(bytes ?? new Uint8Array(0)).toString("utf8");

const nodeProbe = spawnSync("node", ["--version"], { encoding: "utf8" });
const nodeMajor = Number.parseInt(nodeProbe.stdout.trim().slice(1), 10);
const nodeAvailable = !nodeProbe.error && nodeProbe.status === 0 && Number.isFinite(nodeMajor);

function scratchRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `waystation-w02a-${label}-`));
  tmpRoots.push(root);
  return root;
}

function gitFixtureRepo(label: string): string {
  const root = join(scratchRoot(label), "repo with spaces");
  mkdirSync(root, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", "."], { cwd: root });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  return root;
}

function commitFixtureHead(root: string): string {
  writeFileSync(join(root, "file with spaces.txt"), "w02a fixture\n");
  Bun.spawnSync(["git", "add", "--", "file with spaces.txt"], { cwd: root });
  const commit = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.email=w02a@localhost",
      "-c",
      "user.name=w02a",
      "commit",
      "-q",
      "-m",
      "w02a fixture commit",
    ],
    { cwd: root },
  );
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.toString()}`);
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
}

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

describe("gitProcess adapter (W02a)", () => {
  test("both backends produce identical results for the same inputs", () => {
    const repo = gitFixtureRepo("parity");
    const head = commitFixtureHead(repo);
    const results = backends.map((backend) =>
      runGit({ args: ["rev-parse", "HEAD"], cwd: repo, backend }),
    );
    for (const res of results) {
      expect(res.ok).toBe(true);
      expect(res.data?.exitCode).toBe(0);
      expect(decode(res.data?.stdout).trim()).toBe(head);
      expect(res.errors).toHaveLength(0);
    }
    expect(
      Buffer.from(results[0]?.data?.stdout ?? []).equals(
        Buffer.from(results[1]?.data?.stdout ?? []),
      ),
    ).toBe(true);
  });

  test("paths with spaces and platform separators work; arguments are never shell-interpolated", () => {
    const repo = gitFixtureRepo("spaces");
    writeFileSync(join(repo, "untracked spaced file.txt"), "x\n");
    for (const backend of backends) {
      const res = runGit({ args: ["status", "--porcelain"], cwd: repo, backend });
      expect(res.ok).toBe(true);
      expect(res.data?.exitCode).toBe(0);
      expect(decode(res.data?.stdout)).toContain("untracked spaced file.txt");
    }
  });

  test("environment variables merge over the process environment without a shell", () => {
    const repo = gitFixtureRepo("envmerge");
    for (const backend of backends) {
      const res = runGit({
        args: ["config", "--get", "w02a.probe"],
        cwd: repo,
        backend,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "w02a.probe",
          GIT_CONFIG_VALUE_0: "merged-value",
        },
      });
      expect(res.ok).toBe(true);
      expect(decode(res.data?.stdout).trim()).toBe("merged-value");
    }
  });

  for (const backend of backends) {
    test(`time bound yields a coded diagnostic, not a partial success (${backend})`, () => {
      const repo = gitFixtureRepo("timeout");
      const res = runGit({
        args: ["w02a-sleep"],
        cwd: repo,
        backend,
        timeoutMs: 500,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "alias.w02a-sleep",
          GIT_CONFIG_VALUE_0: process.platform === "win32" ? "!ping -n 4 127.0.0.1" : "!sleep 5",
        },
      });
      expect(res.ok).toBe(false);
      expect(res.data).toBe(null);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]?.code).toBe("git_command_failed");
      expect(res.errors[0]?.message).toContain("time bound");
    });

    test(`output bound yields a coded diagnostic, never a truncated message (${backend})`, () => {
      const repo = gitFixtureRepo("overflow");
      const res = runGit({
        args: ["--version"],
        cwd: repo,
        backend,
        maxOutputBytes: 12,
      });
      expect(res.ok).toBe(false);
      expect(res.data).toBe(null);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]?.code).toBe("git_command_failed");
      expect(res.errors[0]?.message).toContain("output bound");
    });

    test(`missing git executable yields a coded launch diagnostic (${backend})`, () => {
      const empty = scratchRoot("nopath");
      const res = runGit({ args: ["--version"], cwd: empty, backend, env: { PATH: empty } });
      expect(res.ok).toBe(false);
      expect(res.data).toBe(null);
      expect(res.errors[0]?.code).toBe("git_command_failed");
      expect(res.errors[0]?.message).toContain("could not be launched");
    });
  }

  test("output within the bound is returned in full", () => {
    const repo = gitFixtureRepo("inbounds");
    const res = runGit({
      args: ["--version"],
      cwd: repo,
      maxOutputBytes: GIT_DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(res.ok).toBe(true);
    expect(decode(res.data?.stdout)).toMatch(/^git version /);
  });

  test.skipIf(!nodeAvailable || nodeMajor < 22)(
    "node fallback: the adapter runs under the real node runtime",
    () => {
      const repo = gitFixtureRepo("nodereal");
      const head = commitFixtureHead(repo);
      const driverDir = scratchRoot("nodedrv");
      const modulePath = fileURLToPath(new URL("../src/core/gitProcess.ts", import.meta.url));
      const driver = join(driverDir, "driver.ts");
      writeFileSync(
        driver,
        [
          'import { pathToFileURL } from "node:url";',
          "const mod = await import(pathToFileURL(process.argv[2] ?? '').href);",
          "const res = mod.runGit({ args: ['rev-parse', 'HEAD'], cwd: process.argv[3] ?? '.', backend: 'node' });",
          "console.log(JSON.stringify({",
          "  ok: res.ok,",
          "  exitCode: res.data === null ? null : res.data.exitCode,",
          "  stdout: res.data === null ? null : Buffer.from(res.data.stdout).toString('utf8'),",
          "  errors: res.errors.map((e) => e.code),",
          "}));",
        ].join("\n"),
      );
      const run = (flags: string[]) =>
        spawnSync("node", [...flags, driver, modulePath, repo], {
          encoding: "utf8",
          timeout: 60_000,
        });
      let out = run([]);
      if (out.status !== 0 && /strip|typescript|experimental/i.test(out.stderr)) {
        out = run(["--experimental-strip-types"]);
      }
      expect(out.status).toBe(0);
      const parsed = JSON.parse(out.stdout.trim()) as {
        ok: boolean;
        exitCode: number | null;
        stdout: string | null;
        errors: string[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout?.trim()).toBe(head);
      expect(parsed.errors).toEqual([]);
    },
  );

  test("the existing git helper keeps its legacy abbreviated-HEAD contract", () => {
    const repo = gitFixtureRepo("legacy");
    commitFixtureHead(repo);
    const state = getGitState(repo);
    expect(state.ok).toBe(true);
    expect(state.data?.head).toMatch(/^[0-9a-f]{7,12}$/);
  });
});
