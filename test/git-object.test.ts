import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type ResolvedCommit, resolveCommitObject } from "../src/core/gitObject.ts";
import { safetyEnv } from "../src/core/gitSafe.ts";

const tmpRoots: string[] = [];
const backends = ["bun", "node"] as const;
const IDENTITY = ["-c", "user.email=w02b@localhost", "-c", "user.name=w02b"];

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

function scratchRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `waystation-w02b-${label}-`));
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

function gitFixtureRepo(label: string, initArgs: string[] = []): string {
  const root = join(scratchRoot(label), "repo with spaces");
  mkdirSync(root, { recursive: true });
  const res = git(root, ["init", "-q", "-b", "main", ...initArgs, "."]);
  if (res.code !== 0) throw new Error(`git init failed: ${res.err}`);
  return root;
}

function commitFile(dir: string, file: string, content: string, msg: string): string {
  writeFileSync(join(dir, file), content);
  gitOr(dir, [...IDENTITY, "add", "--", file]);
  gitOr(dir, [...IDENTITY, "commit", "-q", "-m", msg]);
  return gitOr(dir, ["rev-parse", "HEAD"]);
}

function commitWithMessageBytes(
  dir: string,
  file: string,
  content: string,
  msgBytes: Uint8Array,
  pre: string[] = [],
): string {
  writeFileSync(join(dir, file), content);
  const msgPath = join(dir, "message.bin");
  writeFileSync(msgPath, msgBytes);
  gitOr(dir, [...IDENTITY, "add", "--", file]);
  gitOr(dir, [...IDENTITY, ...pre, "commit", "-q", "--cleanup=verbatim", "-F", "message.bin"]);
  return gitOr(dir, ["rev-parse", "HEAD"]);
}

function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

function resolve(repo: string, ref: string, backend?: (typeof backends)[number]) {
  return resolveCommitObject(ref, { repo, backend });
}

function expectReason(
  result: {
    ok: boolean;
    data: unknown;
    errors: { code: string; message: string; details?: Record<string, unknown> }[];
  },
  reason: string,
): void {
  expect(result.ok).toBe(false);
  expect(result.data).toBe(null);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.code).toBe("invalid_commit_ref");
  expect(result.errors[0]?.details?.reason).toBe(reason);
}

function snapshotTree(root: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix.length === 0 ? name : `${prefix}/${name}`;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) {
      entries.push(...snapshotTree(root, rel));
    } else {
      entries.push(`${rel}:${statSync(full).size}`);
    }
  }
  return entries.sort();
}

describe("resolveCommitObject (W02b)", () => {
  test("full, abbreviated and uppercase inputs resolve to the same full lowercase object ID", () => {
    const repo = gitFixtureRepo("identity");
    const head = commitFile(repo, "a.txt", "a\n", "w02b identity commit");
    for (const backend of backends) {
      for (const ref of [head, head.slice(0, 7), head.toUpperCase()]) {
        const res = resolve(repo, ref, backend);
        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.data?.oid).toBe(head);
        expect(res.data?.oid).toMatch(/^[0-9a-f]{40}$/);
        expect(res.data?.alias).toBe(ref);
      }
    }
  });

  test("symbolic refs, branch and tag names, ranges and revision syntax are rejected before Git runs", () => {
    const repo = gitFixtureRepo("refshaped");
    commitFile(repo, "a.txt", "a\n", "w02b ref-shaped commit");
    gitOr(repo, [...IDENTITY, "tag", "-a", "-m", "tag", "v1.0"]);
    const badRefs = [
      "HEAD",
      "main",
      "v1.0",
      "HEAD~1",
      "HEAD^",
      "abc1234..def5678",
      "abcdef1^{commit}",
      "@{u}",
      ":/text",
      "refs/heads/main",
      "abcdef", // 6 hex characters: below the minimum
      "abcdef0".repeat(10), // 70 hex characters: above the maximum
      "wxyz123",
      "",
    ];
    for (const ref of badRefs) {
      expectReason(resolve(repo, ref), "not_hex");
      expect(resolve(repo, ref).errors[0]?.message).toContain(ref === "" ? '""' : ref);
    }
  });

  test("a hex-shaped branch name is rejected as a ref name, never resolved as one", () => {
    const repo = gitFixtureRepo("refhijack");
    const head = commitFile(repo, "a.txt", "a\n", "w02b hijack commit");
    gitOr(repo, ["branch", "1234567"]);
    // Plain Git resolves the hex-shaped string to the branch tip.
    expect(gitOr(repo, ["rev-parse", "--verify", "1234567"])).toBe(head);
    expectReason(resolve(repo, "1234567"), "ref_name");
  });

  test("an ambiguous abbreviation produces a distinct coded diagnostic", () => {
    const repo = gitFixtureRepo("ambig");
    const a = commitFile(repo, "a.txt", "a\n", "w02b ambiguous commit");
    const fake = `${a.slice(0, 7)}${"0".repeat(33)}`;
    const objDir = join(repo, ".git", "objects", a.slice(0, 2));
    copyFileSync(join(objDir, a.slice(2)), join(objDir, fake.slice(2)));
    expectReason(resolve(repo, a.slice(0, 7)), "ambiguous");
  });

  test("a missing object is unavailable locally, never fetched", () => {
    const repo = gitFixtureRepo("missing");
    const a = commitFile(repo, "a.txt", "a\n", "w02b missing commit");
    gitOr(repo, ["remote", "add", "origin", "http://127.0.0.1:9/never.git"]);
    rmSync(join(repo, ".git", "objects", a.slice(0, 2), a.slice(2)));
    const res = resolve(repo, a);
    expectReason(res, "missing");
    expect(res.errors[0]?.message).toContain("not available locally");
    expectReason(resolve(repo, "abcdefa"), "missing");
  });

  test("non-commit objects and annotated tags are rejected, never peeled", () => {
    const repo = gitFixtureRepo("noncommit");
    const a = commitFile(repo, "a.txt", "a\n", "w02b non-commit target");
    writeFileSync(join(repo, "blob.txt"), "blob\n");
    const blob = gitOr(repo, ["hash-object", "-w", "blob.txt"]);
    expectReason(resolve(repo, blob), "non_commit");
    expect(resolve(repo, blob).errors[0]?.details?.type).toBe("blob");
    gitOr(repo, [...IDENTITY, "tag", "-a", "-m", "tag msg", "v1", a]);
    const tagOid = gitOr(repo, ["rev-parse", "--verify", "v1"]);
    expect(tagOid).not.toBe(a);
    expect(gitOr(repo, ["cat-file", "-t", tagOid])).toBe("tag");
    const res = resolve(repo, tagOid);
    expectReason(res, "non_commit");
    expect(res.errors[0]?.details?.type).toBe("tag");
    expect(res.errors[0]?.message).toContain("not peeled");
    // The commit the tag points to still resolves normally.
    const target = resolve(repo, a);
    expect(target.ok).toBe(true);
    expect(target.data?.oid).toBe(a);
  });

  test("each rejection class produces a pairwise distinct diagnostic", () => {
    const repo = gitFixtureRepo("distinct");
    const a = commitFile(repo, "a.txt", "a\n", "w02b distinct commit");
    gitOr(repo, ["branch", "1234567"]);
    writeFileSync(join(repo, "blob.txt"), "blob\n");
    const blob = gitOr(repo, ["hash-object", "-w", "blob.txt"]);
    rmSync(join(repo, ".git", "objects", a.slice(0, 2), a.slice(2)));
    const samples = [
      resolve(repo, "HEAD"), // not_hex
      resolve(repo, "1234567"), // ref_name
      resolve(repo, a), // missing
      resolve(repo, blob), // non_commit
    ];
    for (const res of samples) expect(res.errors).toHaveLength(1);
    const reasons = samples.map((res) => res.errors[0]?.details?.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    const messages = samples.map((res) => res.errors[0]?.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  test("SHA-256 repositories are handled and the object format is recorded", () => {
    const repo = gitFixtureRepo("sha256", ["--object-format=sha256"]);
    writeFileSync(join(repo, "s.txt"), "s\n");
    gitOr(repo, [...IDENTITY, "add", "--", "s.txt"]);
    gitOr(repo, [...IDENTITY, "commit", "-q", "-m", "sha256 commit"]);
    const head = gitOr(repo, ["rev-parse", "HEAD"]);
    expect(head).toMatch(/^[0-9a-f]{64}$/);
    for (const backend of backends) {
      for (const ref of [head, head.slice(0, 7), head.toUpperCase()]) {
        const res = resolve(repo, ref, backend);
        expect(res.ok).toBe(true);
        expect(res.data?.oid).toBe(head);
        expect(res.data?.objectFormat).toBe("sha256");
      }
    }
  });

  test("replacement refs cannot change the content attributed to an object ID", () => {
    const repo = gitFixtureRepo("replaced");
    const a = commitFile(repo, "a.txt", "a\n", "root message A");
    const b = commitFile(repo, "b.txt", "b\n", "second message B");
    commitFile(repo, "c.txt", "c\n", "third message C");
    gitOr(repo, ["replace", b, a]);
    expect(gitOr(repo, ["replace", "-l"])).toBe(b);
    // Plain Git shows the replacement content for object B.
    expect(gitOr(repo, ["cat-file", "commit", b])).toContain("root message A");
    // The resolver disables replacement refs and reads B's true content.
    const res = resolve(repo, b);
    expect(res.ok).toBe(true);
    expect(res.data?.oid).toBe(b);
    expect(res.data?.message.message).toBe("second message B\n");
    expect(res.data?.parents).toEqual([a]);
  });

  test("root, merge, detached-HEAD and unreachable-from-HEAD commits are valid", () => {
    const repo = gitFixtureRepo("shapes");
    const a = commitFile(repo, "a.txt", "a\n", "root message A");
    const b = commitFile(repo, "b.txt", "b\n", "second message B");
    gitOr(repo, ["checkout", "-q", "-b", "feat", a]);
    const f = commitFile(repo, "f.txt", "f\n", "feature message F");
    gitOr(repo, ["checkout", "-q", "main"]);
    gitOr(repo, [...IDENTITY, "merge", "-q", "--no-ff", "-m", "merge message M", "feat"]);
    const m = gitOr(repo, ["rev-parse", "HEAD"]);

    // Unreachable commit: commit on a detached HEAD, then move away from it.
    gitOr(repo, ["checkout", "-q", "--detach", "HEAD"]);
    const u = commitFile(repo, "u.txt", "u\n", "unreachable message U");
    gitOr(repo, ["checkout", "-q", "--detach", m]);

    const root = resolve(repo, a);
    expect(root.ok).toBe(true);
    expect(root.data?.parents).toEqual([]);
    expect(root.data?.parentCount).toBe(0);

    const merge = resolve(repo, m);
    expect(merge.ok).toBe(true);
    expect(merge.data?.parentCount).toBe(2);
    expect(merge.data?.parents[0]).toBe(b);
    expect([...(merge.data?.parents ?? [])].sort()).toEqual([b, f].sort());

    const unreachable = resolve(repo, u);
    expect(unreachable.ok).toBe(true);
    expect(unreachable.data?.message.message).toBe("unreachable message U\n");

    // Detached HEAD: observational branch is null, HEAD is observed.
    expect(merge.data?.branch).toBe(null);
    expect(merge.data?.head).toBe(m);

    // Moving HEAD does not change the immutable commit under reconciliation.
    const before = resolve(repo, a);
    expect(before.data?.branch).toBe(null);
    gitOr(repo, ["checkout", "-q", "main"]);
    const after = resolve(repo, a);
    expect(after.data?.branch).toBe("main");
    expect(after.data?.head).toBe(m);
    const immutable = (r: { data: ResolvedCommit | null }): unknown =>
      r.data && {
        oid: r.data.oid,
        parents: r.data.parents,
        parentCount: r.data.parentCount,
        message: r.data.message,
      };
    expect(immutable(after)).toEqual(immutable(before));
  });

  test("a bare repository can supply evidence and reports no source worktree", () => {
    const src = gitFixtureRepo("baresource");
    const a = commitFile(src, "a.txt", "a\n", "bare evidence commit");
    const bareRoot = join(scratchRoot("baredst"), "bare.git");
    gitOr(src, ["clone", "-q", "--bare", src, bareRoot]);
    for (const backend of backends) {
      const res = resolve(bareRoot, a, backend);
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.data?.sourceWorktree).toBe(null);
      expect(res.data?.message.message).toBe("bare evidence commit\n");
    }
  });

  test("no fetch, hook or write occurs in the evidence repository", () => {
    const repo = gitFixtureRepo("sterile");
    const marker = join(repo, "hook-ran.marker").replace(/\\/g, "/");
    const hookNames = [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "pre-replace",
      "pre-rebase",
      "post-checkout",
      "post-merge",
      "pre-receive",
      "update",
      "post-update",
      "pre-auto-gc",
      "post-rewrite",
      "reference-transaction",
    ];
    for (const name of hookNames) {
      writeFileSync(join(repo, ".git", "hooks", name), `#!/bin/sh\ntouch "${marker}"\n`);
    }
    // The hooks are functional: an ordinary commit fires them.
    const a = commitFile(repo, "a.txt", "a\n", "w02b sterile commit");
    expect(exists(join(repo, "hook-ran.marker"))).toBe(true);
    rmSync(join(repo, "hook-ran.marker"));

    const before = snapshotTree(join(repo, ".git"));
    for (const backend of backends) {
      const res = resolve(repo, a, backend);
      expect(res.ok).toBe(true);
      expect(exists(join(repo, "hook-ran.marker"))).toBe(false);
      expect(snapshotTree(join(repo, ".git"))).toEqual(before);
    }
    // The safety environment disables prompts and lazy fetching.
    const env = safetyEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
  });

  for (const backend of backends) {
    test(`output bounds produce a coded diagnostic, never a truncated message (${backend})`, () => {
      const repo = gitFixtureRepo("bigmsg");
      const msg = `header line\n${"filler ".repeat(2048)}\n`;
      const a = commitWithMessageBytes(repo, "a.txt", "a\n", Buffer.from(msg, "latin1"));
      const res = resolveCommitObject(a, { repo, backend, maxOutputBytes: 4096 });
      expect(res.ok).toBe(false);
      expect(res.data).toBe(null);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]?.code).toBe("git_command_failed");
      expect(res.errors[0]?.message).toContain("output bound");
    });

    test(`time bounds produce a coded diagnostic, never a partially verified object (${backend})`, () => {
      const repo = gitFixtureRepo("timebound");
      const a = commitFile(repo, "a.txt", "a\n", "w02b time-bound commit");
      const res = resolveCommitObject(a, { repo, backend, timeoutMs: 1 });
      expect(res.ok).toBe(false);
      expect(res.data).toBe(null);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]?.code).toBe("git_command_failed");
      expect(res.errors[0]?.message).toContain("time bound");
    });
  }

  test("stored descriptions stay byte-faithful: CRLF, declared encodings and non-UTF-8 bytes", () => {
    const repo = gitFixtureRepo("bytes");
    const crlf = Buffer.from("line one\r\nline two\r\n", "latin1");
    const crlfOid = commitWithMessageBytes(repo, "a.txt", "a\n", crlf);
    const crlfRes = resolve(repo, crlfOid);
    expect(crlfRes.ok).toBe(true);
    expect(crlfRes.data?.message.decodedLosslessly).toBe(true);
    expect(crlfRes.data?.message.message).toBe("line one\r\nline two\r\n");
    expect(crlfRes.data?.message.rawMessageBase64).toBe(null);
    expect(crlfRes.data?.message.encoding).toBe(null);

    const latin1Bytes = Buffer.from([0xe9, 0xe8, 0xff, 0xfe, 0x41]);
    const latin1Oid = commitWithMessageBytes(repo, "b.txt", "b\n", latin1Bytes, [
      "-c",
      "i18n.commitEncoding=ISO-8859-1",
    ]);
    const latin1Res = resolve(repo, latin1Oid);
    expect(latin1Res.ok).toBe(true);
    expect(latin1Res.data?.message.encoding).toBe("ISO-8859-1");
    if (latin1Res.data?.message.decodedLosslessly) {
      expect(latin1Res.data.message.rawMessageBase64).toBe(null);
      expect(latin1Res.data.message.message).toBe("éèÿþA");
    } else {
      expect(Buffer.from(latin1Res.data?.message.rawMessageBase64 ?? "", "base64")).toEqual(
        latin1Bytes,
      );
    }

    // `git commit -F` re-encodes non-UTF-8 messages to UTF-8 on Windows, so the
    // invalid-UTF-8 commit is written verbatim into the object database with
    // hash-object, which stores its stdin bytes exactly.
    const tree = gitOr(repo, ["rev-parse", "HEAD^{tree}"]);
    const header = Buffer.from(
      `tree ${tree}\nauthor W02b <w02b@localhost> 1700000000 +0000\ncommitter W02b <w02b@localhost> 1700000000 +0000\n\n`,
      "latin1",
    );
    const invalid = Buffer.concat([header, Buffer.from([0x41, 0xe9, 0xe8, 0xff, 0xfe])]);
    const craft = Bun.spawnSync(
      ["git", ...IDENTITY, "hash-object", "-t", "commit", "-w", "--stdin"],
      {
        cwd: repo,
        stdin: invalid,
      },
    );
    if (craft.exitCode !== 0) throw new Error(`hash-object failed: ${craft.stderr.toString()}`);
    const invalidOid = craft.stdout.toString().trim();
    const invalidRes = resolve(repo, invalidOid);
    expect(invalidRes.ok).toBe(true);
    expect(invalidRes.data?.message.decodedLosslessly).toBe(false);
    expect(invalidRes.data?.message.encoding).toBe(null);
    expect(Buffer.from(invalidRes.data?.message.rawMessageBase64 ?? "", "base64")).toEqual(
      Buffer.from([0x41, 0xe9, 0xe8, 0xff, 0xfe]),
    );
    expect(invalidRes.data?.message.message).toContain("\uFFFD");
  });

  test("a non-repository evidence path is a distinct coded diagnostic", () => {
    const plain = scratchRoot("notrepo");
    const plainRes = resolve(plain, "abcdef1234567");
    expect(plainRes.ok).toBe(false);
    expect(plainRes.errors[0]?.code).toBe("git_not_repository");
    const missing = join(scratchRoot("missingdir"), "nope");
    const missingRes = resolve(missing, "abcdef1234567");
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errors[0]?.code).toBe("git_not_repository");
  });

  const nodeProbe = spawnSync("node", ["--version"], { encoding: "utf8" });
  const nodeMajor = Number.parseInt(nodeProbe.stdout.trim().slice(1), 10);
  const nodeAvailable = !nodeProbe.error && nodeProbe.status === 0 && Number.isFinite(nodeMajor);
  test.skipIf(!nodeAvailable || nodeMajor < 22)(
    "node fallback: the resolver runs under the real node runtime",
    () => {
      const repo = gitFixtureRepo("nodereal");
      const head = commitFile(repo, "a.txt", "a\n", "w02b node parity commit");
      const driverDir = scratchRoot("nodedrv");
      const modulePath = fileURLToPath(new URL("../src/core/gitObject.ts", import.meta.url));
      const driver = join(driverDir, "driver.ts");
      writeFileSync(
        driver,
        [
          'import { pathToFileURL } from "node:url";',
          "const mod = await import(pathToFileURL(process.argv[2] ?? '').href);",
          "const repo = process.argv[3] ?? '.';",
          "const refs = process.argv.slice(4);",
          "const results = refs.map((ref) => {",
          "  const res = mod.resolveCommitObject(ref, { repo, backend: 'node' });",
          "  return { ref, ok: res.ok, oid: res.data === null ? null : res.data.oid,",
          "    message: res.data === null ? null : res.data.message.message,",
          "    parents: res.data === null ? null : res.data.parents };",
          "});",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const refs = [head, head.slice(0, 7), head.toUpperCase()];
      const run = (flags: string[]) =>
        spawnSync("node", [...flags, driver, modulePath, repo, ...refs], {
          encoding: "utf8",
          timeout: 60_000,
        });
      let out = run([]);
      if (out.status !== 0 && /strip|typescript|experimental/i.test(out.stderr)) {
        out = run(["--experimental-strip-types"]);
      }
      expect(out.status).toBe(0);
      const parsed = JSON.parse(out.stdout.trim()) as {
        ref: string;
        ok: boolean;
        oid: string | null;
        message: string | null;
        parents: string[] | null;
      }[];
      expect(parsed).toHaveLength(refs.length);
      for (const row of parsed) {
        expect(row.ok).toBe(true);
        expect(row.oid).toBe(head);
        expect(row.message).toBe("w02b node parity commit\n");
        expect(row.parents).toEqual([]);
      }
    },
  );
});
