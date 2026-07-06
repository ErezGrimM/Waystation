import { createIssue } from "./issue.ts";
import { type CommandResult, diag, okResult, toResult } from "./result.ts";
import type { IssueRecord } from "./schema.ts";
import { loadIssues } from "./store.ts";

const LABEL_TO_TYPE = new Map<string, string>([
  ["bug", "bug"],
  ["feature", "feature"],
  ["enhancement", "feature"],
  ["question", "question"],
  ["documentation", "task"],
]);

const LABEL_TO_SEVERITY = new Map<string, string>([
  ["critical", "critical"],
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
]);

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "waystation",
  };
}

function parseLinkHeader(link: string | null): string | null {
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(link);
  return m?.[1] ?? null;
}

async function ghFetch(
  url: string,
  token: string,
): Promise<{ data: unknown; next: string | null }> {
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text();
    }
    throw new Error(`GitHub API ${res.status}: ${detail || res.statusText}`);
  }
  const data = await res.json();
  return { data, next: parseLinkHeader(res.headers.get("link")) };
}

async function fetchAllIssues(repo: string, token: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`;
  while (url) {
    const { data, next } = await ghFetch(url, token);
    items.push(...(data as unknown[]));
    url = next ?? "";
  }
  return items;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

function extractLabels(issue: GitHubIssue): { type?: string; severity?: string } {
  let type: string | undefined;
  let severity: string | undefined;
  for (const l of issue.labels) {
    const name = l.name.toLowerCase();
    if (!type && LABEL_TO_TYPE.has(name)) type = LABEL_TO_TYPE.get(name);
    if (!severity && LABEL_TO_SEVERITY.has(name)) severity = LABEL_TO_SEVERITY.get(name);
  }
  return { type, severity };
}

export async function importGitHubIssues(
  root: string,
  repo: string,
  token: string,
): Promise<CommandResult<{ imported: number; ids: string[] }>> {
  if (!token) {
    return toResult<{ imported: number; ids: string[] }>(null, [diag("no_github_token")]);
  }

  const existing = new Set(loadIssues(root).map((i) => i.id));

  try {
    const raw = await fetchAllIssues(repo, token);
    const created: string[] = [];
    for (const r of raw) {
      const ghIssue = r as GitHubIssue;
      const id = `gh-${ghIssue.number}`;
      if (existing.has(id)) continue;

      const { type, severity } = extractLabels(ghIssue);

      await createIssue(root, {
        id,
        title: ghIssue.title,
        status: ghIssue.state === "open" ? "open" : "closed",
        severity,
        type,
        description: ghIssue.body ?? undefined,
      });

      existing.add(id);
      created.push(id);
    }

    return okResult({ imported: created.length, ids: created });
  } catch (e) {
    return toResult<{ imported: number; ids: string[] }>(null, [
      diag("github_api_error", {
        message: (e as Error).message,
        details: { repo },
      }),
    ]);
  }
}

function buildGitHubBody(issue: IssueRecord): string {
  const parts: string[] = [];
  if (issue.type) parts.push(`**Type:** ${issue.type}`);
  if (issue.severity) parts.push(`**Severity:** ${issue.severity}`);
  if (parts.length) parts.push("");
  return parts.join("\n");
}

export async function exportGitHubIssues(
  root: string,
  repo: string,
  token: string,
): Promise<CommandResult<{ exported: number; ids: string[] }>> {
  if (!token) {
    return toResult<{ exported: number; ids: string[] }>(null, [diag("no_github_token")]);
  }

  try {
    const issues = loadIssues(root);
    const exported: string[] = [];

    for (const issue of issues) {
      const ghNumMatch = /^gh-(\d+)$/.exec(issue.id);
      const preamble = buildGitHubBody(issue);
      const bodyParts: string[] = [];
      if (preamble) bodyParts.push(preamble);
      bodyParts.push(issue.id);
      const body = bodyParts.join("\n");

      const labels: string[] = [];
      if (issue.type) labels.push(issue.type);
      if (issue.severity) labels.push(issue.severity);

      const payload: Record<string, unknown> = {
        title: issue.title,
        body,
        labels,
      };

      if (issue.status === "closed" || issue.status === "done" || issue.status === "fixed") {
        payload.state = "closed";
      }

      if (ghNumMatch) {
        const num = ghNumMatch[1] ?? "";
        if (!num) continue;
        payload.state_reason =
          issue.status === "closed" || issue.status === "done" ? "completed" : "not_planned";
        const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
          method: "PATCH",
          headers: { ...ghHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`GitHub API ${res.status} updating #${num}: ${errBody}`);
        }
      } else {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: "POST",
          headers: { ...ghHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`GitHub API ${res.status} creating issue: ${errBody}`);
        }
      }

      exported.push(issue.id);
    }

    return okResult({ exported: exported.length, ids: exported });
  } catch (e) {
    return toResult<{ exported: number; ids: string[] }>(null, [
      diag("github_api_error", {
        message: (e as Error).message,
        details: { repo },
      }),
    ]);
  }
}
