import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrief, buildBriefResult } from "../src/core/brief.ts";
import {
  enrichFromGraph,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  loadGraphData,
} from "../src/core/graph.ts";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "waystation-graph-test-"));
  tmpRoots.push(root);
  return root;
}

function writeGraph(root: string, graph: unknown): void {
  const graphDir = join(root, "graphify-out");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "graph.json"), JSON.stringify(graph, null, 2));
}

function node(id: string, file: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name: id,
    file,
    type: "code",
    location: null,
    summary: null,
    community: null,
    communityName: null,
    ...extra,
  };
}

function edge(source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source,
    target,
    type: "calls",
    label: null,
    confidence: "EXTRACTED",
    ...extra,
  };
}

function graph(nodes: GraphNode[], edges: GraphEdge[], directed = true): GraphData {
  return { directed, nodes, edges, concepts: [] };
}

describe("Graphify compatibility", () => {
  test("accepts links, nullable optional fields, community metadata, and no concepts", () => {
    const root = fixtureRoot();
    writeGraph(root, {
      directed: false,
      nodes: [
        {
          id: "profile",
          label: "profileSchema",
          file_type: "code",
          source_file: "internal\\schema\\profile.go",
          source_location: null,
          _origin: null,
          summary: "Builds semantic schema profiles",
          community: 12,
          community_name: "Schema Profiling",
        },
        {
          id: "consumer",
          label: "renderProfile",
          file_type: "code",
          source_file: "cmd/duckbrain/profile.go",
          source_location: null,
          summary: null,
          community: 12,
          community_name: "Schema Profiling",
        },
      ],
      links: [
        {
          source: "profile",
          target: "consumer",
          relation: "references",
          context: null,
          confidence: null,
          source_file: null,
          source_location: null,
          weight: null,
        },
      ],
    });

    const loaded = loadGraphData(root);
    expect(loaded.ok).toBe(true);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.data?.directed).toBe(false);
    expect(loaded.data?.edges).toHaveLength(1);
    expect(loaded.data?.nodes[0]?.file).toBe("internal/schema/profile.go");

    const enriched = enrichFromGraph(loaded.data!, {
      pathHints: ["internal/schema/profile.go"],
      taskTitle: "Add schema profiling",
    });
    expect(enriched.relatedFiles).toEqual([
      "internal/schema/profile.go",
      "cmd/duckbrain/profile.go",
    ]);
    expect(enriched.concepts).toEqual(["Schema Profiling"]);
    expect(enriched.impactHints).toEqual([
      "internal/schema/profile.go is connected to: cmd/duckbrain/profile.go",
    ]);
  });

  test("returns a warning diagnostic for malformed and incompatible graph data", () => {
    const malformedRoot = fixtureRoot();
    const graphDir = join(malformedRoot, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "graph.json"), "{ not json }");

    const malformed = loadGraphData(malformedRoot);
    expect(malformed.ok).toBe(true);
    expect(malformed.data?.nodes).toEqual([]);
    expect(malformed.warnings[0]?.code).toBe("graph_data_invalid");
    expect(malformed.warnings[0]?.details?.reason).toBe("invalid_json");

    const incompatibleRoot = fixtureRoot();
    writeGraph(incompatibleRoot, { nodes: "not-an-array", links: [] });
    const incompatible = loadGraphData(incompatibleRoot);
    expect(incompatible.ok).toBe(true);
    expect(incompatible.warnings[0]?.code).toBe("graph_data_invalid");
    expect(incompatible.warnings[0]?.details?.reason).toBe("schema_invalid");
  });
});

describe("Graphify enrichment ranking", () => {
  test("never matches or emits blank paths and deduplicates symbol nodes by file", () => {
    const data = graph(
      [
        node("blank", ""),
        node("seed-a", "src/core/brief.ts"),
        node("seed-b", "src/core/brief.ts"),
        node("target-a", "src/core/tasks.ts"),
        node("target-b", "src/core/tasks.ts"),
      ],
      [edge("blank", "target-a"), edge("seed-a", "target-a"), edge("seed-b", "target-b")],
    );

    const enriched = enrichFromGraph(data, {
      pathHints: ["src/core/brief.ts", "src/core/"],
    });
    expect(enriched.relatedFiles).toEqual(["src/core/brief.ts", "src/core/tasks.ts"]);
    expect(enriched.relatedFiles).not.toContain("");
    expect(enriched.impactHints).toEqual([
      "src/core/brief.ts depends on: src/core/tasks.ts",
      "src/core/tasks.ts is depended on by: src/core/brief.ts",
    ]);
    expect(enriched.impactHints.join(" ")).not.toContain(": ,");
  });

  test("ranks before truncation and is invariant to node and edge order", () => {
    const directoryNodes = Array.from({ length: 20 }, (_, index) =>
      node(`broad-${index}`, `src/generated/file-${String(index).padStart(2, "0")}.ts`),
    );
    const nodes = [
      node("blank", ""),
      ...directoryNodes,
      node("exact", "src/exact.ts"),
      node("connected", "lib/connected.ts"),
    ];
    const edges = [edge("exact", "connected"), edge("blank", "connected")];
    const context = { pathHints: ["src/", "src/exact.ts"] };

    const forward = enrichFromGraph(graph(nodes, edges), context);
    const shuffled = enrichFromGraph(graph([...nodes].reverse(), [...edges].reverse()), context);

    expect(forward).toEqual(shuffled);
    expect(forward.relatedFiles).toHaveLength(15);
    expect(forward.relatedFiles[0]).toBe("src/exact.ts");
    expect(forward.relatedFiles).not.toContain("");
    expect(forward.relatedFiles.slice(1)).toEqual(
      [...forward.relatedFiles.slice(1)].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("orders extracted neighbors first and uses directional wording only for directed graphs", () => {
    const nodes = [
      node("seed", "src/seed.ts"),
      node("inferred", "src/a-inferred.ts"),
      node("extracted", "src/z-extracted.ts"),
    ];
    const edges = [
      edge("seed", "inferred", { confidence: "INFERRED" }),
      edge("seed", "extracted", { confidence: "EXTRACTED" }),
    ];
    const context = { pathHints: ["src/seed.ts"] };

    const directed = enrichFromGraph(graph(nodes, edges, true), context);
    expect(directed.impactHints).toEqual([
      "src/seed.ts depends on: src/z-extracted.ts, src/a-inferred.ts",
    ]);

    const undirected = enrichFromGraph(graph(nodes, edges, false), context);
    expect(undirected.impactHints).toEqual([
      "src/seed.ts is connected to: src/z-extracted.ts, src/a-inferred.ts",
    ]);
  });
});

describe("configured brief budget", () => {
  test("uses defaults.brief_budget when omitted and lets an explicit budget override it", () => {
    const root = fixtureRoot();
    const ledger = join(root, ".waystation");
    const tasks = join(ledger, "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(
      join(tasks, "task-graph.json"),
      JSON.stringify({
        id: "task-graph",
        title: "Graph task",
        status: "ready",
        priority: 2,
        scope: null,
        path_hints: ["src/seed.ts"],
        prompts: [],
        dependencies: [],
        acceptance: [],
      }),
    );
    writeFileSync(
      join(ledger, "config.json"),
      JSON.stringify({ defaults: { brief_budget: "large" } }),
    );
    writeGraph(root, {
      nodes: [{ id: "seed", label: "seed", file_type: "code", source_file: "src/seed.ts" }],
      links: [],
    });

    const configured = buildBrief(root, "task-graph");
    expect(configured.budget).toBe("large");
    expect(configured.relatedFiles).toEqual(["src/seed.ts"]);

    const explicit = buildBrief(root, "task-graph", "small");
    expect(explicit.budget).toBe("small");
    expect(explicit.relatedFiles).toEqual([]);
  });

  test("preserves graph warnings in the brief command result", () => {
    const root = fixtureRoot();
    const ledger = join(root, ".waystation");
    const tasks = join(ledger, "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(
      join(tasks, "task-graph.json"),
      JSON.stringify({
        id: "task-graph",
        title: "Graph task",
        status: "ready",
        priority: 2,
        scope: null,
        path_hints: ["src/seed.ts"],
        prompts: [],
        dependencies: [],
        acceptance: [],
      }),
    );
    writeFileSync(
      join(ledger, "config.json"),
      JSON.stringify({ defaults: { brief_budget: "large" } }),
    );
    const graphDir = join(root, "graphify-out");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "graph.json"), "{ invalid }");

    const result = buildBriefResult(root, "task-graph");
    expect(result.ok).toBe(true);
    expect(result.data?.relatedFiles).toEqual([]);
    expect(result.warnings[0]?.code).toBe("graph_data_invalid");
  });
});
