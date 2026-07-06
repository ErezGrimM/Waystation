import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type CommandResult, okResult } from "./result.ts";

const RawGraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  file_type: z.string(),
  source_file: z.string(),
  source_location: z.string().optional(),
  _origin: z.string().optional(),
  summary: z.string().optional(),
});

const RawGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
  context: z.string().optional(),
  confidence: z.string().optional(),
  source_file: z.string().optional(),
  source_location: z.string().optional(),
  weight: z.number().optional(),
});

const RawGraphDataSchema = z.object({
  nodes: z.array(RawGraphNodeSchema),
  edges: z.array(RawGraphEdgeSchema),
  concepts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        keywords: z.array(z.string()).optional(),
        summary: z.string().optional(),
      }),
    )
    .optional(),
});

export interface GraphNode {
  id: string;
  name: string;
  file: string;
  type: string;
  location: string | null;
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
  nodes: GraphNode[];
  edges: GraphEdge[];
  concepts: GraphConcept[];
}

function remapGraph(raw: z.infer<typeof RawGraphDataSchema>): GraphData {
  return {
    nodes: raw.nodes.map((n) => ({
      id: n.id,
      name: n.label,
      file: n.source_file,
      type: n.file_type,
      location: n.source_location ?? null,
    })),
    edges: raw.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.relation,
      label: e.context ?? null,
      confidence: e.confidence ?? null,
    })),
    concepts:
      raw.concepts?.map((c) => ({
        id: c.id,
        name: c.name,
        keywords: c.keywords ?? [],
        summary: c.summary ?? null,
      })) ?? [],
  };
}

export function loadGraphData(root: string, graphPath?: string): CommandResult<GraphData> {
  const path = graphPath ?? join(root, "graphify-out", "graph.json");

  if (!existsSync(path)) {
    return okResult({ nodes: [], edges: [], concepts: [] });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return okResult({ nodes: [], edges: [], concepts: [] });
  }

  const parsed = RawGraphDataSchema.safeParse(raw);

  if (!parsed.success) {
    return okResult({ nodes: [], edges: [], concepts: [] });
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

export function enrichFromGraph(graph: GraphData, context: EnrichmentContext): EnrichmentResult {
  if (graph.nodes.length === 0) {
    return { relatedFiles: [], concepts: [], impactHints: [] };
  }

  const relatedFiles = findRelatedFiles(graph, context.pathHints);
  const concepts = findRelevantConcepts(graph, context);
  const impactHints = findImpactHints(graph, context.pathHints);

  return {
    relatedFiles: relatedFiles.slice(0, 15),
    concepts: concepts.slice(0, 5),
    impactHints: impactHints.slice(0, 5),
  };
}

function findRelatedFiles(graph: GraphData, pathHints: string[]): string[] {
  const related = new Set<string>();

  for (const hint of pathHints) {
    const matchingNodes = graph.nodes.filter(
      (node) => node.file.includes(hint) || hint.includes(node.file),
    );

    for (const node of matchingNodes) {
      related.add(node.file);

      const connectedEdges = graph.edges.filter(
        (edge) => edge.source === node.id || edge.target === node.id,
      );

      for (const edge of connectedEdges) {
        const otherNodeId = edge.source === node.id ? edge.target : edge.source;
        const otherNode = graph.nodes.find((n) => n.id === otherNodeId);
        if (otherNode) {
          related.add(otherNode.file);
        }
      }
    }
  }

  return Array.from(related);
}

function findRelevantConcepts(graph: GraphData, context: EnrichmentContext): string[] {
  if (graph.concepts.length === 0) {
    return [];
  }

  const text =
    `${context.taskTitle ?? ""} ${context.taskDescription ?? ""} ${context.taskScope ?? ""}`.toLowerCase();
  const relevant: string[] = [];

  for (const concept of graph.concepts) {
    const matches = concept.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
    if (matches) {
      relevant.push(concept.name);
    }
  }

  return relevant;
}

function findImpactHints(graph: GraphData, pathHints: string[]): string[] {
  const hints: string[] = [];
  const processedNodes = new Set<string>();

  for (const hint of pathHints) {
    const matchingNodes = graph.nodes.filter(
      (node) => node.file.includes(hint) || hint.includes(node.file),
    );

    for (const node of matchingNodes) {
      if (processedNodes.has(node.id)) continue;
      processedNodes.add(node.id);

      const inbound = graph.edges.filter((edge) => edge.target === node.id);
      const outbound = graph.edges.filter((edge) => edge.source === node.id);

      if (inbound.length > 0) {
        const dependents = inbound
          .map((edge) => graph.nodes.find((n) => n.id === edge.source))
          .filter((n): n is GraphNode => n !== undefined)
          .slice(0, 3);

        if (dependents.length > 0) {
          hints.push(`${node.file} is depended on by: ${dependents.map((d) => d.file).join(", ")}`);
        }
      }

      if (outbound.length > 0) {
        const dependencies = outbound
          .map((edge) => graph.nodes.find((n) => n.id === edge.target))
          .filter((n): n is GraphNode => n !== undefined)
          .slice(0, 3);

        if (dependencies.length > 0) {
          hints.push(`${node.file} depends on: ${dependencies.map((d) => d.file).join(", ")}`);
        }
      }
    }
  }

  return hints;
}
