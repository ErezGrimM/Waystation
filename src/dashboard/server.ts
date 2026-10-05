import { join, resolve, sep } from "node:path";
import { buildBriefResult, configuredBriefBudget, parseBriefBudget } from "../core/brief.ts";
import { emitMutationEvent, onMutationEvent } from "../core/events.ts";
import { reindex } from "../core/generate.ts";
import { exportGitHubIssues, importGitHubIssues } from "../core/gh.ts";
import { getGitState } from "../core/git.ts";
import { buildGitContext } from "../core/gitContext.ts";
import { createHandoff } from "../core/handoff.ts";
import { closeIssue, createIssue, type UpdateIssueInput, updateIssue } from "../core/issue.ts";
import { inbox, postMessage, threadMessages } from "../core/messages.ts";
import {
  addTaskCommits,
  type CreateTaskInput,
  claimTask,
  createTask,
  finishTask,
  MutationError,
  releaseTask,
  reopenTask,
  setTaskStatus,
  type TaskPatch,
  updateTask,
} from "../core/mutate.ts";
import { resolveLedgerRoot } from "../core/paths.ts";
import { loadPrompts, renderPrompt, selectPrompts } from "../core/prompt.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { type CommandResult, diag, okResult, toResult } from "../core/result.ts";
import type { TaskStatus } from "../core/schema.ts";
import { LockError, loadClaims, loadIssues, withLedgerLock } from "../core/store.ts";
import { indexById, nextTask, taskReadiness } from "../core/tasks.ts";
import { byInstantThenId } from "../core/time.ts";
import { validateLedger } from "../core/validate.ts";

function json(result: CommandResult): Response {
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
    status: result.ok ? 200 : 422,
  });
}

function catchDiag(e: unknown, fallbackCode: string = "unexpected_error") {
  // MutationError messages are domain-level and safe to surface. RecordError and
  // unknown errors embed absolute paths / raw internals, so we log those server
  // side and return only the catalog's generic message (audit M2).
  if (e instanceof MutationError) {
    return toResult(null, [diag(e.code as never, { message: e.message })]);
  }
  if (e instanceof RecordError) {
    console.error("[waystation] record error:", e.message);
    return toResult(null, [diag(e.code as never)]);
  }
  if (e instanceof LockError) {
    return toResult(null, [diag(e.code as never)]);
  }
  console.error("[waystation] unexpected error:", e);
  return toResult(null, [diag(fallbackCode as never)]);
}

/**
 * Resolve `fullPath` and confirm it stays within `baseDir`; returns the
 * resolved path or null if it escapes (path-traversal guard, audit M1). This is
 * defense in depth — it does not rely on the runtime normalizing the URL first.
 */
function fileWithin(baseDir: string, fullPath: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(fullPath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

function emitMutationSummary(type: string, data: Record<string, unknown>) {
  // gh import/export are dashboard-level summary events, not journal events;
  // journaled mutations already broadcast from the core write path.
  emitMutationEvent({ type, ...data });
}

function gitStatusFiles(root: string): string[] {
  const state = getGitState(root);
  return state.data?.status.files.map((file) => file.file) ?? [];
}

function taskViews(root: string) {
  const tasks = loadTasks(root);
  const byId = indexById(tasks);
  return tasks.map((task) => ({
    ...task,
    readiness: taskReadiness(task, byId),
    ledgerRoot: root,
  }));
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Extract the hostname (no port) from a URL or Origin header value; null if unparseable. */
function hostOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function forbidden(): Response {
  return new Response(JSON.stringify(toResult(null, [diag("forbidden_origin")])), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Guard against DNS-rebinding and cross-site (CSRF) requests. The dashboard
 * binds to loopback, but that is not a browser boundary: any page the user
 * visits can issue "simple" cross-origin POSTs whose side effects execute, and
 * a rebound DNS name can turn a remote page into an apparent same-origin
 * caller. We therefore (a) require the request host itself to be loopback on
 * every request — the request URL host reflects the Host header and defeats DNS
 * rebinding for reads and writes; and (b) on mutating methods, require any
 * Origin to also be loopback — defeats cross-site simple-request CSRF.
 * Non-browser clients (CLI, tests) send loopback URLs and no Origin, so they
 * are unaffected.
 */
function originGuard(url: string, method: string, origin: string | undefined): Response | null {
  const reqHost = hostOf(url);
  if (!reqHost || !LOOPBACK_HOSTS.has(reqHost)) return forbidden();
  if (MUTATING_METHODS.has(method) && origin) {
    const originHost = hostOf(origin);
    if (!originHost || !LOOPBACK_HOSTS.has(originHost)) return forbidden();
  }
  return null;
}

/** Dashboard source root, independent of the ledger selected by --root. */
export function dashboardClientDir(): string {
  return join(import.meta.dir, "client");
}

/**
 * Production assets live beside this module in source mode and under the same
 * relative path in Bun's embedded filesystem after `bun build --compile --asset`.
 */
export function productionDashboardDir(): string {
  return Bun.isStandaloneExecutable
    ? join(import.meta.dir, "dist")
    : join(dashboardClientDir(), "dist");
}

// ── Route table ─────────────────────────────────────────────────────────────

type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  url: URL,
) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  if (pattern === "*") return {};
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    if (path.startsWith(prefix)) {
      return { "*": path.slice(prefix.length) };
    }
    return null;
  }
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const part = pathParts[i];
    if (p === undefined || part === undefined) return null;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(part);
    } else if (p !== part) {
      return null;
    }
  }
  return params;
}

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new Error(`Missing required parameter: ${name}`);
  return value;
}

// ── Dashboard app ───────────────────────────────────────────────────────────

export interface DashboardMiddlewareContext {
  req: {
    path: string;
    url: string;
    method: string;
    headers: Headers;
  };
}

export type DashboardMiddlewareHandler = (
  ctx: DashboardMiddlewareContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export interface DashboardApp {
  fetch: (request: Request) => Response | Promise<Response>;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  use: (pattern: string, handler: DashboardMiddlewareHandler) => DashboardApp;
}

/** Create a dashboard bound to one validated ledger root. */
export function createApp(root?: string, distDir?: string): DashboardApp {
  return createAppAtRoot(resolveLedgerRoot({ explicitRoot: root }), distDir);
}

function createAppAtRoot(root: string, distDir?: string): DashboardApp {
  const routes: Route[] = [
    // ── status ──
    {
      method: "GET",
      pattern: "/api/status",
      handler: () => {
        try {
          const tasks = loadTasks(root);
          const counts: Record<string, number> = {};
          for (const t of tasks) {
            counts[t.status] = (counts[t.status] ?? 0) + 1;
          }
          const next = nextTask(tasks);
          return json(okResult({ ledgerRoot: root, total: tasks.length, counts, next }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── tasks ──
    {
      method: "GET",
      pattern: "/api/tasks",
      handler: (_req, _params, url) => {
        try {
          const tasks = taskViews(root);
          const status = url.searchParams.get("status");
          const sort = url.searchParams.get("sort") ?? "created_at";
          const order = url.searchParams.get("order") ?? "desc";
          let filtered = tasks;
          if (status) filtered = tasks.filter((t) => t.status === status);
          filtered.sort((a, b) => {
            let cmp = 0;
            switch (sort) {
              case "priority":
                cmp = a.priority - b.priority;
                break;
              case "title":
                cmp = a.title.localeCompare(b.title);
                break;
              case "updated_at":
                cmp = byInstantThenId(a, b, "updated_at");
                break;
              default:
                cmp = byInstantThenId(a, b, "created_at");
            }
            if (cmp === 0) cmp = a.id.localeCompare(b.id);
            return order === "asc" ? cmp : -cmp;
          });
          return json(okResult(filtered));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "GET",
      pattern: "/api/tasks/:id",
      handler: (_req, params) => {
        try {
          const task = taskViews(root).find((t) => t.id === requireParam(params, "id")) ?? null;
          if (!task) {
            return json(
              toResult(null, [
                diag("no_such_task", {
                  message: `no such task: ${requireParam(params, "id")}`,
                  details: { id: requireParam(params, "id") },
                }),
              ]),
            );
          }
          return json(okResult(task));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks",
      handler: async (req) => {
        try {
          const body = (await req.json()) as CreateTaskInput & { actor?: string };
          const { actor = "dashboard", ...input } = body;
          const task = await createTask(root, input, actor);
          return json(okResult(task));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "PATCH",
      pattern: "/api/tasks/:id",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as TaskPatch & { actor?: string };
          const { actor = "dashboard", ...patch } = body;
          const task = await updateTask(root, requireParam(params, "id"), patch, actor);
          return json(okResult(task));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks/:id/status",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as { status: TaskStatus; actor?: string };
          const actor = body.actor ?? "dashboard";
          const task = await setTaskStatus(root, requireParam(params, "id"), body.status, actor);
          return json(okResult(task));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks/:id/reopen",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as { status: "todo" | "ready"; actor?: string };
          const actor = body.actor ?? "dashboard";
          const task = await reopenTask(root, requireParam(params, "id"), body.status, actor);
          return json(okResult(task));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "GET",
      pattern: "/api/tasks/:id/brief",
      handler: (_req, params, url) => {
        try {
          const budget = parseBriefBudget(
            url.searchParams.get("budget") ?? configuredBriefBudget(root),
          );
          if (!budget.ok || !budget.data) return json(budget);
          return json(buildBriefResult(root, requireParam(params, "id"), budget.data));
        } catch (e) {
          return json(catchDiag(e, "no_such_task"));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks/:id/claim",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as { agent: string };
          const claim = await claimTask(root, requireParam(params, "id"), body.agent);
          return json(okResult(claim));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks/:id/release",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as { agent: string };
          await releaseTask(root, requireParam(params, "id"), body.agent);
          return json(okResult({ released: requireParam(params, "id") }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/tasks/:id/finish",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as {
            agent: string;
            commits?: string[];
            commitHead?: boolean;
          };
          await finishTask(root, requireParam(params, "id"), body.agent, new Date(), {
            commits: body.commits ?? [],
            commitHead: body.commitHead,
          });
          return json(okResult({ finished: requireParam(params, "id") }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── issues ──
    {
      method: "GET",
      pattern: "/api/issues",
      handler: () => {
        try {
          return json(okResult(loadIssues(root)));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "GET",
      pattern: "/api/issues/:id",
      handler: (_req, params) => {
        try {
          const issue = loadIssues(root).find((item) => item.id === requireParam(params, "id"));
          if (!issue) {
            return json(
              toResult(null, [
                diag("not_found", {
                  message: `no such issue: ${requireParam(params, "id")}`,
                  details: { id: requireParam(params, "id") },
                }),
              ]),
            );
          }
          return json(okResult({ ...issue, ledgerRoot: root }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/issues",
      handler: async (req) => {
        try {
          const body = await req.json();
          const issue = await createIssue(root, body);
          return json(okResult(issue));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "PATCH",
      pattern: "/api/issues/:id",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as UpdateIssueInput & { actor?: string };
          const { actor = "dashboard", ...patch } = body;
          const issue = await updateIssue(root, requireParam(params, "id"), patch, actor);
          return json(okResult(issue));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/issues/:id/close",
      handler: async (req, params) => {
        try {
          const body = (await req.json()) as { resolution: string; actor?: string };
          const actor = body.actor ?? "dashboard";
          const issue = await closeIssue(root, requireParam(params, "id"), body.resolution, actor);
          return json(okResult(issue));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── github integration ──
    {
      method: "POST",
      pattern: "/api/gh/import",
      handler: async (req) => {
        try {
          const body = (await req.json()) as { repo: string };
          const token = process.env.GITHUB_TOKEN ?? "";
          const result = await importGitHubIssues(root, body.repo, token);
          if (result.ok) {
            emitMutationSummary("gh.imported", {
              repo: body.repo,
              count: result.data?.imported ?? 0,
            });
          }
          return json(result);
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/gh/export",
      handler: async (req) => {
        try {
          const body = (await req.json()) as { repo: string };
          const token = process.env.GITHUB_TOKEN ?? "";
          const result = await exportGitHubIssues(root, body.repo, token);
          if (result.ok) {
            emitMutationSummary("gh.exported", {
              repo: body.repo,
              count: result.data?.exported ?? 0,
            });
          }
          return json(result);
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── messages ──
    {
      method: "GET",
      pattern: "/api/messages",
      handler: (_req, _params, url) => {
        const thread = url.searchParams.get("thread");
        if (thread) {
          return json(okResult(threadMessages(root, thread)));
        }
        return json(okResult(threadMessages(root, "project")));
      },
    },

    {
      method: "GET",
      pattern: "/api/messages/inbox/:agent",
      handler: (_req, params, url) => {
        const since = url.searchParams.get("since") ?? undefined;
        return json(okResult(inbox(root, requireParam(params, "agent"), since)));
      },
    },

    {
      method: "POST",
      pattern: "/api/messages",
      handler: async (req) => {
        try {
          const body = (await req.json()) as {
            thread: string;
            from: string;
            to?: string;
            kind?: string;
            body: string;
          };
          const m = await postMessage(root, {
            thread: body.thread,
            from: body.from,
            to: body.to ?? null,
            kind: body.kind as never,
            body: body.body,
          });
          return json(okResult(m));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── prompts ──
    {
      method: "GET",
      pattern: "/api/prompts",
      handler: () => {
        return json(okResult(loadPrompts(root)));
      },
    },

    {
      method: "GET",
      pattern: "/api/prompts/render",
      handler: (_req, _params, url) => {
        const taskId = url.searchParams.get("task");
        const agent = url.searchParams.get("agent");
        if (!taskId || !agent) {
          return json(
            toResult(null, [
              diag("unexpected_error" as never, {
                message: "task and agent query params required",
              }),
            ]),
          );
        }
        const loaded = loadTasks(root);
        const task = loaded.find((t) => t.id === taskId);
        if (!task) {
          return json(
            toResult(null, [
              diag("no_such_task", { message: `no such task: ${taskId}`, details: { id: taskId } }),
            ]),
          );
        }
        const role = url.searchParams.get("role") ?? undefined;
        const ctx = { agent, role, task: task.id, scope: task.scope ?? undefined };
        const vars = { task_id: task.id, agent, scope: task.scope ?? undefined };
        const selected = selectPrompts(root, ctx);
        const rendered = selected.length
          ? selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n")
          : "No applicable prompts.\n";
        return json(okResult({ prompts: selected.map((p) => p.id), rendered }));
      },
    },

    // ── handoffs ──
    {
      method: "POST",
      pattern: "/api/handoffs",
      handler: async (req) => {
        try {
          const body = (await req.json()) as {
            task: string;
            from: string;
            to?: string;
            summary?: string;
          };
          const h = await createHandoff(root, {
            task: body.task,
            from: body.from,
            to: body.to ?? null,
            summary: body.summary,
          });
          return json(okResult(h));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── claims ──
    {
      method: "GET",
      pattern: "/api/claims",
      handler: (_req, _params, url) => {
        try {
          let claims = loadClaims(root);
          const status = url.searchParams.get("status");
          if (status) claims = claims.filter((cl) => cl.status === status);
          claims.sort((a, b) => -byInstantThenId(a, b, "claimed_at"));
          return json(okResult(claims));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── validate ──
    {
      method: "GET",
      pattern: "/api/validate",
      handler: () => {
        return json(validateLedger(root));
      },
    },

    // ── git ──
    {
      method: "GET",
      pattern: "/api/git/status",
      handler: () => {
        const state = getGitState(root);
        if (!state.ok || !state.data) return json(state);
        return json(
          okResult({
            root: state.data.root,
            worktree: state.data.worktree,
            branch: state.data.branch,
            detached: state.data.detached,
            head: state.data.head,
            ...state.data.status,
          }),
        );
      },
    },

    {
      method: "GET",
      pattern: "/api/git/context",
      handler: () => {
        return json(buildGitContext(root));
      },
    },

    {
      method: "GET",
      pattern: "/api/git/diff",
      handler: () => {
        try {
          const proc = Bun.spawnSync(["git", "diff", "--stat"], { cwd: root });
          const diffText = proc.stdout.toString().trim();
          const staged = Bun.spawnSync(["git", "diff", "--stat", "--cached"], { cwd: root });
          const stagedText = staged.stdout.toString().trim();
          return json(okResult({ diff: diffText || null, staged: stagedText || null }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    {
      method: "POST",
      pattern: "/api/git/commit",
      handler: async (req) => {
        try {
          const body = (await req.json()) as { message: string; files?: string[]; task?: string };
          if (!body.message) {
            return json(
              toResult(null, [
                diag("unexpected_error" as never, { message: "commit message required" }),
              ]),
            );
          }
          if (body.files && body.files.length > 0) {
            const allowed = new Set(gitStatusFiles(root));
            const invalid = body.files.filter((file) => !allowed.has(file));
            if (invalid.length > 0) {
              return json(
                toResult(null, [
                  diag("unexpected_error" as never, {
                    message: `invalid file selection: ${invalid.join(", ")}`,
                  }),
                ]),
              );
            }
            const add = Bun.spawnSync(["git", "add", "--", ...body.files], { cwd: root });
            if (add.exitCode !== 0) {
              return json(
                toResult(null, [
                  diag("unexpected_error" as never, {
                    message: add.stderr.toString().trim() || "git add failed",
                  }),
                ]),
              );
            }
          } else {
            return json(
              toResult(null, [
                diag("unexpected_error" as never, {
                  message:
                    "no files selected; choose files to commit (blind git add -A is disabled)",
                }),
              ]),
            );
          }
          const proc = Bun.spawnSync(["git", "commit", "-m", body.message], { cwd: root });
          const out = proc.stdout.toString().trim();
          const err = proc.stderr.toString().trim();
          if (proc.exitCode !== 0) {
            return json(
              toResult(null, [
                diag("unexpected_error" as never, { message: err || "commit failed" }),
              ]),
            );
          }
          const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
          const commit = head.exitCode === 0 ? head.stdout.toString().trim() : null;
          if (body.task && commit) {
            await addTaskCommits(root, body.task, [commit], "dashboard");
          }
          return json(okResult({ output: out || "committed", commit, task: body.task ?? null }));
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── reindex ──
    {
      method: "POST",
      pattern: "/api/reindex",
      handler: async () => {
        try {
          const result = await withLedgerLock(root, () => reindex(root));
          return json(result);
        } catch (e) {
          return json(catchDiag(e));
        }
      },
    },

    // ── SSE ──
    {
      method: "GET",
      pattern: "/api/events",
      handler: (req) => {
        let closed = false;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(": heartbeat\n\n");
            const heartbeat = setInterval(() => {
              if (!closed) {
                try {
                  controller.enqueue(": heartbeat\n\n");
                } catch {
                  clearInterval(heartbeat);
                }
              } else {
                clearInterval(heartbeat);
              }
            }, 15_000);
            const unsub = onMutationEvent((event) => {
              if (!closed) {
                controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
              }
            });
            req.signal.addEventListener("abort", () => {
              closed = true;
              clearInterval(heartbeat);
              unsub();
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },

    // ── static SPA (production) ──
    {
      method: "GET",
      pattern: "/graphify-out/*",
      handler: (_req, params) => {
        const target = fileWithin(
          join(root, "graphify-out"),
          join(root, "graphify-out", requireParam(params, "*")),
        );
        if (!target) return new Response("Not Found", { status: 404 });
        const file = Bun.file(target);
        return file.exists().then((exists) => {
          if (exists) return new Response(file);
          return new Response("Not Found", { status: 404 });
        });
      },
    },
  ];

  if (distDir) {
    routes.push(
      {
        method: "GET",
        pattern: "/assets/*",
        handler: (_req, params) => {
          const assetRoot = join(distDir, "assets");
          const relativePath = requireParam(params, "*");
          const target = fileWithin(assetRoot, join(assetRoot, relativePath));
          if (!target) return new Response("Not Found", { status: 404 });
          const file = Bun.file(target);
          return file.exists().then((exists) => {
            if (exists) return new Response(file);
            return new Response("Not Found", { status: 404 });
          });
        },
      },
      {
        method: "GET",
        pattern: "/favicon.ico",
        handler: () => {
          const file = Bun.file(join(distDir, "favicon.ico"));
          return file.exists().then((exists) => {
            if (exists) return new Response(file);
            return new Response("Not Found", { status: 404 });
          });
        },
      },
      {
        method: "GET",
        pattern: "*",
        handler: () => {
          const file = Bun.file(join(distDir, "index.html"));
          return file.exists().then((exists) => {
            if (exists) return new Response(file, { headers: { "Content-Type": "text/html" } });
            return new Response("Not Found", { status: 404 });
          });
        },
      },
    );
  } else {
    routes.push({
      method: "GET",
      pattern: "/",
      handler: () => {
        return new Response(
          "<h1>Waystation Dashboard</h1><p>API ready. Use --dev for the SPA.</p>",
          {
            headers: { "Content-Type": "text/html" },
          },
        );
      },
    });
  }

  async function fetch(request: Request): Promise<Response> {
    const blocked = originGuard(
      request.url,
      request.method,
      request.headers.get("origin") ?? undefined,
    );
    if (blocked) return blocked;

    const url = new URL(request.url);
    const path = url.pathname;

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const params = matchPattern(route.pattern, path);
      if (params) {
        return route.handler(request, params, url);
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  async function request(input: string | Request, init?: RequestInit): Promise<Response> {
    if (typeof input === "string") {
      const path = input.startsWith("/") ? input : `/${input}`;
      const req = new Request(`http://localhost${path}`, init);
      return fetch(req);
    }
    return fetch(input);
  }

  function use(_pattern: string, _handler: DashboardMiddlewareHandler): DashboardApp {
    return app;
  }

  const app: DashboardApp = { fetch, request, use };
  return app;
}
