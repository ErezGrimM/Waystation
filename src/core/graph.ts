import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type CommandResult, diag, okResult, toResult } from "./result.ts";

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["function", "class", "file", "module"]),
  file: z.string(),
  name: z.string(),
  summary: z.string().optional(),
});

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(["calls", "imports", "depends_on", "called_by"]),
  label: z.string().optional(),
});

export const GraphConceptSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  summary: z.string().optional(),
});

export const GraphDataSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  concepts: z.array(GraphConceptSchema).optional(),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphConcept = z.infer<typeof GraphConceptSchema>;
export type GraphData = z.infer<typeof GraphDataSchema>;

export function loadGraphData(
  root: string,
  graphPath?: string,
): CommandResult<GraphData> {
  const path = graphPath ?? join(root, "graphify-out", "graph.json");

  if (!existsSync(path)) {
    return okResult({ nodes: [], edges: [], concepts: [] });
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = GraphDataSchema.safeParse(raw);

    if (!parsed.success) {
      return toResult(null, [
        diag("graph_data_invalid", {
          message: `Graph data validation failed: ${parsed.error.message}`,
          details: { path },
        }),
      ]);
    }

    return okResult(parsed.data);
  } catch (e) {
    return toResult(null, [
      diag("graph_data_invalid", {
        message: `Failed to load graph data: ${(e as Error).message}`,
        details: { path },
      }),
    ]);
  }
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

export function enrichFromGraph(
  graph: GraphData,
  context: EnrichmentContext,
): EnrichmentResult {
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
    const matchingNodes = graph.nodes.filter((node) =>
      node.file.includes(hint) || hint.includes(node.file),
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

function findRelevantConcepts(
  graph: GraphData,
  context: EnrichmentContext,
): string[] {
  if (!graph.concepts || graph.concepts.length === 0) {
    return [];
  }

  const text = `${context.taskTitle ?? ""} ${context.taskDescription ?? ""} ${context.taskScope ?? ""}`.toLowerCase();
  const relevant: string[] = [];

  for (const concept of graph.concepts) {
    const matches = concept.keywords.some((keyword) =>
      text.includes(keyword.toLowerCase()),
    );
    if (matches) {
      relevant.push(concept.name);
    }
  }

  return relevant;
}

function findImpactHints(graph: GraphData, pathHints: string[]): string[] {
  const hints: string[] = [];

  for (const hint of pathHints) {
    const matchingNodes = graph.nodes.filter((node) =>
      node.file.includes(hint) || hint.includes(node.file),
    );

    for (const node of matchingNodes) {
      const inbound = graph.edges.filter((edge) => edge.target === node.id);
      const outbound = graph.edges.filter((edge) => edge.source === node.id);

      if (inbound.length > 0) {
        const dependents = inbound
          .map((edge) => graph.nodes.find((n) => n.id === edge.source))
          .filter((n): n is GraphNode => n !== undefined)
          .slice(0, 3);

        if (dependents.length > 0) {
          hints.push(
            `${node.file} is depended on by: ${dependents.map((d) => d.file).join(", ")}`,
          );
        }
      }

      if (outbound.length > 0) {
        const dependencies = outbound
          .map((edge) => graph.nodes.find((n) => n.id === edge.target))
          .filter((n): n is GraphNode => n !== undefined)
          .slice(0, 3);

        if (dependencies.length > 0) {
          hints.push(
            `${node.file} depends on: ${dependencies.map((d) => d.file).join(", ")}`,
          );
        }
      }
    }
  }

  return hints;
}
