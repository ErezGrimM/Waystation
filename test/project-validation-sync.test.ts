import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedGeneratedArtifacts,
  generateReports,
  generateTaskViews,
  reindex,
} from "../src/core/generate.ts";
import { canonicalFingerprint, syncLedger } from "../src/core/sync.ts";
import { validateLedger } from "../src/core/validate.ts";

const roots: string[] = [];

function fixture(tasks: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-project-validation-"));
  roots.push(root);
  const taskDir = join(root, ".waystation", "tasks");
  mkdirSync(taskDir, { recursive: true });
  for (const task of tasks) {
    writeFileSync(join(taskDir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`);
  }
  return root;
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-a",
    title: "A",
    status: "ready",
    priority: 1,
    path_hints: [],
    dependencies: [],
    acceptance: [],
    ...overrides,
  };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("project validation", () => {
  test("warns for escaping and missing literal relative path hints but skips globs", () => {
    const root = fixture([
      task({
        path_hints: ["src/existing.ts", "src/planned.ts", "../outside.ts", "src/**/*.ts"],
      }),
    ]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "existing.ts"), "export {};\n");
    generateReports(root);

    const result = validateLedger(root, { project: true, projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "path_hint_missing",
      "path_hint_escapes_project",
    ]);
    expect(result.warnings.some((warning) => warning.message.includes("**"))).toBe(false);
  });

  test("detects default and requested task-view drift without rewriting files", () => {
    const root = fixture([task()]);
    generateReports(root);
    expect(validateLedger(root, { project: true, projectRoot: root }).ok).toBe(true);

    const status = join(root, ".waystation", "reports", "STATUS.md");
    writeFileSync(status, "stale\n");
    const stale = validateLedger(root, { project: true, projectRoot: root });
    expect(stale.errors.map((error) => error.code)).toContain("generated_artifact_stale");
    expect(readFileSync(status, "utf8")).toBe("stale\n");

    generateReports(root);
    const view = join(root, ".waystation", "views", "tasks", "task-a.md");
    mkdirSync(join(view, ".."), { recursive: true });
    writeFileSync(view, "stale view\n");
    expect(validateLedger(root, { project: true, projectRoot: root }).ok).toBe(true);
    expect(validateLedger(root, { project: true, projectRoot: root, views: true }).ok).toBe(false);

    generateTaskViews(root);
    expect(validateLedger(root, { project: true, projectRoot: root, views: true }).ok).toBe(true);
  });

  test("all generated Markdown ends in exactly one LF", () => {
    const root = fixture([task({ description: "Description\n\n", acceptance: ["Done"] })]);
    generateReports(root);
    generateTaskViews(root);
    for (const artifact of expectedGeneratedArtifacts(root, true)) {
      const bytes = readFileSync(artifact.file);
      expect(bytes.at(-1)).toBe(0x0a);
      expect(bytes.at(-2)).not.toBe(0x0a);
      expect(artifact.content.includes("\r")).toBe(false);
    }
  });
});

describe("sync", () => {
  test("stops before creating derived output when canonical validation fails", async () => {
    const root = fixture([task({ status: "invalid" })]);
    const result = await syncLedger(root, { projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("schema_invalid");
    expect(existsSync(join(root, ".waystation", "index.sqlite"))).toBe(false);
    expect(existsSync(join(root, ".waystation", "reports", "STATUS.md"))).toBe(false);
  });

  test("is byte-idempotent and reports total and active claims separately", async () => {
    const root = fixture([task({ status: "in_progress" })]);
    const claims = join(root, ".waystation", "claims");
    mkdirSync(claims, { recursive: true });
    writeFileSync(
      join(claims, "claim-active.json"),
      `${JSON.stringify({
        id: "claim-active",
        task: "task-a",
        agent: "coder",
        status: "active",
        claimed_at: "2026-07-17T08:00:00Z",
      })}\n`,
    );
    writeFileSync(
      join(claims, "claim-released.json"),
      `${JSON.stringify({
        id: "claim-released",
        task: "task-a",
        agent: "former",
        status: "released",
        claimed_at: "2026-07-16T08:00:00Z",
        released_at: "2026-07-16T09:00:00Z",
      })}\n`,
    );

    const first = await syncLedger(root, { projectRoot: root, views: true });
    expect(first.ok).toBe(true);
    expect(first.data?.index.claims_total).toBe(2);
    expect(first.data?.index.claims_active).toBe(1);
    const firstBytes = expectedGeneratedArtifacts(root, true).map((artifact) =>
      readFileSync(artifact.file, "utf8"),
    );

    const second = await syncLedger(root, { projectRoot: root, views: true });
    expect(second.ok).toBe(true);
    expect(
      expectedGeneratedArtifacts(root, true).map((artifact) => readFileSync(artifact.file, "utf8")),
    ).toEqual(firstBytes);
  });

  test("canonical fingerprints ignore derived files and detect canonical changes", async () => {
    const root = fixture([task()]);
    const before = canonicalFingerprint(root);
    generateReports(root);
    expect(canonicalFingerprint(root)).toBe(before);

    writeFileSync(join(root, ".waystation", "tasks", "task-a.json"), JSON.stringify(task()));
    expect(canonicalFingerprint(root)).not.toBe(before);
    const indexed = await reindex(root);
    expect(indexed.data).toEqual({
      tasks: 1,
      issues: 0,
      claims_total: 0,
      claims_active: 0,
      messages: 0,
    });
  });
});
