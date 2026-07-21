import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type CommandResult, diag, okResult } from "./result.ts";

const NullableString = z.string().nullish();

const RawGraphNodeSchema = z.object({
  id: z.string(),
  label: NullableString,
  file_type: NullableString,
  source_file: NullableString,
  source_location: NullableString,
  _origin: NullableString,
  summary: NullableString,
  community: z.union([z.string(), z.number()]).nullish(),
  community_name: NullableString,
});

const RawGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: NullableString,
  context: NullableString,
  confidence: NullableString,
  source_file: NullableString,
  source_location: NullableString,
  weight: z.number().nullish(),
});

const RawGraphConceptSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()).nullish(),
  summary: NullableString,
});

const RawGraphDataSchema = z.object({
  directed: z.boolean().nullish(),
  nodes: z.array(RawGraphNodeSchema),
  edges: z.array(RawGraphEdgeSchema).nullish(),
  links: z.array(RawGraphEdgeSchema).nullish(),
  concepts: z.array(RawGraphConceptSchema).nullish(),
});

export interface GraphNode {
  id: string;
  name: string;
  file: string;
  type: string;
  location: string | null;
  summary: string | null;
  community: string | null;
  communityName: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  label: string | null;
  confidence: string | null;
}

export interface GraphConcept {
  id: string;
  name: string;
  keywords: string[];
  summary: string | null;
}

export interface GraphData {
  directed: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  concepts: GraphConcept[];
}

const emptyGraph = (): GraphData => ({ directed: true, nodes: [], edges: [], concepts: [] });

function normalizePath(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function canonicalPath(value: string | null | undefined): string {
  const normalized = normalizePath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function remapGraph(raw: z.infer<typeof RawGraphDataSchema>): GraphData {
  const rawEdges = raw.edges ?? raw.links ?? [];
  return {
    directed: raw.directed ?? true,
    nodes: raw.nodes.map((node) => ({
      id: node.id,
      name: node.label ?? "",
      file: normalizePath(node.source_file),
      type: node.file_type ?? "unknown",
      location: node.source_location ?? null,
      summary: node.summary ?? null,
      community:
        node.community === null || node.community === undefined ? null : String(node.community),
      communityName: node.community_name ?? null,
    })),
    edges: rawEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.relation ?? "connected",
      label: edge.context ?? null,
      confidence: edge.confidence ?? null,
    })),
    concepts:
      raw.concepts?.map((concept) => ({
        id: concept.id,
        name: concept.name,
        keywords: concept.keywords ?? [],
        summary: concept.summary ?? null,
      })) ?? [],
  };
}

export function loadGraphData(root: string, graphPath?: string): CommandResult<GraphData> {
  const path = graphPath ?? join(root, "graphify-out", "graph.json");

  if (!existsSync(path)) return okResult(emptyGraph());

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return okResult(emptyGraph(), [
      diag("graph_data_invalid", { details: { path, reason: "invalid_json" } }),
    ]);
  }

  const parsed = RawGraphDataSchema.safeParse(raw);
  if (!parsed.success) {
    return okResult(emptyGraph(), [
      diag("graph_data_invalid", {
        details: {
          path,
          reason: "schema_invalid",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      }),
    ]);
  }

  return okResult(remapGraph(parsed.data));
}

export interface EnrichmentContext {
  pathHints: string[];
  taskTitle?: string;
  taskDescription?: string;
  taskScope?: string;
}

export interface EnrichmentResult {
  relatedFiles: string[];
  concepts: string[];
  impactHints: string[];
}

interface IndexedFile {
  key: string;
  path: string;
  nodes: GraphNode[];
}

interface GraphIndex {
  nodeById: Map<string, GraphNode>;
  edgesByNode: Map<string, GraphEdge[]>;
  files: Map<string, IndexedFile>;
}

interface SeedFile extends IndexedFile {
  rank: number;
}

interface RankedFile {
  path: string;
  rank: number;
  edgeRank: number;
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function buildGraphIndex(graph: GraphData): GraphIndex {
  const nodeById = new Map<string, GraphNode>();
  const edgesByNode = new Map<string, GraphEdge[]>();
  const files = new Map<string, IndexedFile>();

  for (const node of [...graph.nodes].sort((a, b) => compareText(a.id, b.id))) {
    nodeById.set(node.id, node);
    const key = canonicalPath(node.file);
    if (!key) continue;
    const existing = files.get(key);
    if (existing) {
      existing.nodes.push(node);
      if (compareText(node.file, existing.path) < 0) existing.path = node.file;
    } else {
      files.set(key, { key, path: node.file, nodes: [node] });
    }
  }

  for (const edge of graph.edges) {
    const sourceEdges = edgesByNode.get(edge.source) ?? [];
    sourceEdges.push(edge);
    edgesByNode.set(edge.source, sourceEdges);
    if (edge.target !== edge.source) {
      const targetEdges = edgesByNode.get(edge.target) ?? [];
      targetEdges.push(edge);
      edgesByNode.set(edge.target, targetEdges);
    }
  }

  return { nodeById, edgesByNode, files };
}

function normalizedHints(pathHints: string[]): string[] {
  return Array.from(new Set(pathHints.map(canonicalPath).filter(Boolean))).sort(compareText);
}

function hintRank(file: string, hints: string[]): number | null {
  let rank: number | null = null;
  for (const hint of hints) {
    if (!file || !hint) continue;
    const candidate = file === hint ? 0 : file.startsWith(`${hint}/`) ? 1 : null;
    if (candidate !== null && (rank === null || candidate < rank)) rank = candidate;
  }
  return rank;
}

function seedFiles(index: GraphIndex, pathHints: string[]): SeedFile[] {
  const hints = normalizedHints(pathHints);
  const seeds: SeedFile[] = [];
  for (const file of index.files.values()) {
    const rank = hintRank(file.key, hints);
    if (rank !== null) seeds.push({ ...file, rank });
  }
  return seeds.sort((a, b) => a.rank - b.rank || compareText(a.path, b.path));
}

function edgeRank(edge: GraphEdge): number {
  return edge.confidence?.toLowerCase() === "extracted" ? 0 : 1;
}

function connectedNodeId(edge: GraphEdge, nodeId: string): string | null {
  if (edge.source === nodeId) return edge.target;
  if (edge.target === nodeId) return edge.source;
  return null;
}

function setBestRankedFile(
  target: Map<string, RankedFile>,
  key: string,
  candidate: RankedFile,
): void {
  const current = target.get(key);
  if (
    !current ||
    candidate.rank < current.rank ||
    (candidate.rank === current.rank && candidate.edgeRank < current.edgeRank)
  ) {
    target.set(key, candidate);
  }
}

function findRelatedFiles(index: GraphIndex, pathHints: string[]): string[] {
  const ranked = new Map<string, RankedFile>();
  const seeds = seedFiles(index, pathHints);

  for (const seed of seeds) {
    setBestRankedFile(ranked, seed.key, { path: seed.path, rank: seed.rank, edgeRank: 0 });
    for (const node of seed.nodes) {
      for (const edge of index.edgesByNode.get(node.id) ?? []) {
        const otherId = connectedNodeId(edge, node.id);
        const otherNode = otherId ? index.nodeById.get(otherId) : undefined;
        const otherKey = canonicalPath(otherNode?.file);
        if (!otherNode || !otherKey || otherKey === seed.key) continue;
        const indexed = index.files.get(otherKey);
        if (!indexed) continue;
        setBestRankedFile(ranked, otherKey, {
          path: indexed.path,
          rank: seed.rank + 2,
          edgeRank: edgeRank(edge),
        });
      }
    }
  }

  return Array.from(ranked.values())
    .sort((a, b) => a.rank - b.rank || a.edgeRank - b.edgeRank || compareText(a.path, b.path))
    .map((candidate) => candidate.path);
}

function significantTerms(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((term) => term.length >= 4),
    ),
  );
}

function findRelevantConcepts(
  graph: GraphData,
  context: EnrichmentContext,
  index: GraphIndex,
): string[] {
  const text =
    `${context.taskTitle ?? ""} ${context.taskDescription ?? ""} ${context.taskScope ?? ""}`.toLowerCase();

  if (graph.concepts.length > 0) {
    return graph.concepts
      .filter(
        (concept) =>
          text.includes(concept.name.toLowerCase()) ||
          concept.keywords.some((keyword) => text.includes(keyword.toLowerCase())),
      )
      .map((concept) => concept.name)
      .sort(compareText);
  }

  const seedKeys = new Set(seedFiles(index, context.pathHints).map((seed) => seed.key));
  const terms = significantTerms(text);
  const communities = new Map<string, { name: string; rank: number }>();

  for (const node of graph.nodes) {
    const name = node.communityName?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const nodeText = `${name} ${node.name} ${node.summary ?? ""}`.toLowerCase();
    const pathMatch = seedKeys.has(canonicalPath(node.file));
    const textMatch = text.includes(key) || terms.some((term) => nodeText.includes(term));
    if (!pathMatch && !textMatch) continue;
    const rank = pathMatch ? 0 : 1;
    const existing = communities.get(key);
    if (!existing || rank < existing.rank) communities.set(key, { name, rank });
  }

  return Array.from(communities.values())
    .sort((a, b) => a.rank - b.rank || compareText(a.name, b.name))
    .map((community) => community.name);
}

interface ConnectedFile {
  path: string;
  edgeRank: number;
}

function collectConnectedFiles(
  index: GraphIndex,
  seed: SeedFile,
  direction: "inbound" | "outbound" | "either",
): ConnectedFile[] {
  const connected = new Map<string, ConnectedFile>();
  for (const node of seed.nodes) {
    for (const edge of index.edgesByNode.get(node.id) ?? []) {
      if (direction === "inbound" && edge.target !== node.id) continue;
      if (direction === "outbound" && edge.source !== node.id) continue;
      const otherId = connectedNodeId(edge, node.id);
      const otherNode = otherId ? index.nodeById.get(otherId) : undefined;
      const otherKey = canonicalPath(otherNode?.file);
      if (!otherNode || !otherKey || otherKey === seed.key) continue;
      const indexed = index.files.get(otherKey);
      if (!indexed) continue;
      const candidate = { path: indexed.path, edgeRank: edgeRank(edge) };
      const existing = connected.get(otherKey);
      if (!existing || candidate.edgeRank < existing.edgeRank) connected.set(otherKey, candidate);
    }
  }
  return Array.from(connected.values()).sort(
    (a, b) => a.edgeRank - b.edgeRank || compareText(a.path, b.path),
  );
}

function findImpactHints(graph: GraphData, index: GraphIndex, pathHints: string[]): string[] {
  const ranked: Array<{ rank: number; direction: number; subject: string; text: string }> = [];

  for (const seed of seedFiles(index, pathHints)) {
    if (!graph.directed) {
      const connected = collectConnectedFiles(index, seed, "either").slice(0, 3);
      if (connected.length > 0) {
        ranked.push({
          rank: seed.rank,
          direction: 0,
          subject: seed.path,
          text: `${seed.path} is connected to: ${connected.map((item) => item.path).join(", ")}`,
        });
      }
      continue;
    }

    const inbound = collectConnectedFiles(index, seed, "inbound").slice(0, 3);
    if (inbound.length > 0) {
      ranked.push({
        rank: seed.rank,
        direction: 0,
        subject: seed.path,
        text: `${seed.path} is depended on by: ${inbound.map((item) => item.path).join(", ")}`,
      });
    }
    const outbound = collectConnectedFiles(index, seed, "outbound").slice(0, 3);
    if (outbound.length > 0) {
      ranked.push({
        rank: seed.rank,
        direction: 1,
        subject: seed.path,
        text: `${seed.path} depends on: ${outbound.map((item) => item.path).join(", ")}`,
      });
    }
  }

  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        compareText(a.subject, b.subject) ||
        a.direction - b.direction ||
        compareText(a.text, b.text),
    )
    .map((hint) => hint.text);
}

export function enrichFromGraph(graph: GraphData, context: EnrichmentContext): EnrichmentResult {
  if (graph.nodes.length === 0) {
    return { relatedFiles: [], concepts: [], impactHints: [] };
  }

  const index = buildGraphIndex(graph);
  return {
    relatedFiles: findRelatedFiles(index, context.pathHints).slice(0, 15),
    concepts: findRelevantConcepts(graph, context, index).slice(0, 5),
    impactHints: findImpactHints(graph, index, context.pathHints).slice(0, 5),
  };
}
