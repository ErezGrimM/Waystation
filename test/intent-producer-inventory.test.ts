import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(projectRoot, "src");

/**
 * Every module that calls `buildIntent` to produce a mutation intent. These are
 * the "producers" the migration had to adopt; a new producer must be added here
 * and to the version-2 constructor, so this list doubles as the guard against a
 * silently-accepted hand-built (or version-1) intent.
 */
const PRODUCERS = [
  "src/core/mutate.ts",
  "src/core/handoff.ts",
  "src/core/issue.ts",
  "src/core/messages.ts",
];

/**
 * The definition site of `buildIntent`. It references the name (it defines it)
 * and also carries the legitimate version-1 read/verify path, so it is not a
 * producer and is excluded from the "no version: 1 literal" check below.
 */
const DEFINITION = "src/core/store.ts";

/** Recursively list files under `dir`. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** All TypeScript source files, as project-relative forward-slash paths. */
function sourceFiles(): string[] {
  return listFiles(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => relative(projectRoot, f).split(sep).join("/"));
}

function readSource(rel: string): string {
  return readFileSync(join(projectRoot, rel), "utf8");
}

describe("W01c producer inventory (F1)", () => {
  test("names every producer, and the set of buildIntent-referencing files is exactly the inventory", () => {
    const referencing = sourceFiles()
      .filter((f) => readSource(f).includes("buildIntent"))
      .sort();
    const expected = [...PRODUCERS, DEFINITION].sort();

    const diff = {
      missing: expected.filter((f) => !referencing.includes(f)),
      unexpected: referencing.filter((f) => !expected.includes(f)),
    };
    // A `missing` entry means a known producer stopped building through the v2
    // constructor; an `unexpected` entry means a NEW producer appeared without
    // being registered (and therefore without a version-2 guarantee).
    expect(diff).toEqual({ missing: [], unexpected: [] });
  });

  test("no producer constructs a hand-built version-1 intent literal", () => {
    // Scoped to producer modules only: store.ts legitimately hosts the v1
    // read/verify path, and the deliberate v1 intents in the test fixtures
    // exercise recovery compatibility — neither is a producer. A producer that
    // reintroduces `version: 1` bypasses buildIntent's version-2 constructor.
    const offenders: Array<{ file: string; line: number }> = [];
    for (const rel of PRODUCERS) {
      readSource(rel)
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/version\s*:\s*1\b/.test(line)) offenders.push({ file: rel, line: i + 1 });
        });
    }
    expect(offenders).toEqual([]);
  });
});
