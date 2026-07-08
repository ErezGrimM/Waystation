import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import type { BriefBudget } from "../core/brief.ts";
import { buildBrief } from "../core/brief.ts";
import { emitMutationEvent, onMutationEvent } from "../core/events.ts";
import { reindex } from "../core/generate.ts";
import { exportGitHubIssues, importGitHubIssues } from "../core/gh.ts";
import { getGitState } from "../core/git.ts";
import { buildGitContext } from "../core/gitContext.ts";
import { createHandoff } from "../core/handoff.ts";
import { createIssue } from "../core/issue.ts";
import { inbox, postMessage, threadMessages } from "../core/messages.ts";
import { claimTask, finishTask, MutationError, releaseTask } from "../core/mutate.ts";
import { loadPrompts, renderPrompt, selectPrompts } from "../core/prompt.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { type CommandResult, diag, okResult, toResult } from "../core/result.ts";
import { loadClaims, loadIssues } from "../core/store.ts";
import { nextTask } from "../core/tasks.ts";
import { nowIso } from "../core/time.ts";
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

function emit(type: string, data: Record<string, unknown>) {
  emitMutationEvent({ type, ...data, ts: nowIso() });
}

function gitStatusFiles(root: string): string[] {
  const state = getGitState(root);
  return state.data?.status.files.map((file) => file.file) ?? [];
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

export function createApp(root: string, distDir?: string): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const blocked = originGuard(c.req.url, c.req.method, c.req.header("origin"));
    if (blocked) return blocked;
    await next();
  });

  // ── status ──

  app.get("/api/status", (_c) => {
    try {
      const tasks = loadTasks(root);
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
      const next = nextTask(tasks);
      return json(okResult({ total: tasks.length, counts, next }));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── tasks ──

  app.get("/api/tasks", (c) => {
    try {
      const tasks = loadTasks(root);
      const status = c.req.query("status");
      const sort = c.req.query("sort") ?? "created_at";
      const order = c.req.query("order") ?? "desc";
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
            cmp = (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
            break;
          default:
            cmp = (a.created_at ?? "").localeCompare(b.created_at ?? "");
        }
        if (cmp === 0) cmp = a.id.localeCompare(b.id);
        return order === "asc" ? cmp : -cmp;
      });
      return json(okResult(filtered));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const task = loadTasks(root).find((t) => t.id === c.req.param("id")) ?? null;
    if (!task) {
      const id = c.req.param("id");
      return json(
        toResult(null, [diag("no_such_task", { message: `no such task: ${id}`, details: { id } })]),
      );
    }
    return json(okResult(task));
  });

  app.get("/api/tasks/:id/brief", (c) => {
    try {
      const brief = buildBrief(
        root,
        c.req.param("id"),
        (c.req.query("budget") as BriefBudget) ?? "medium",
      );
      return json(okResult(brief));
    } catch (e) {
      return json(catchDiag(e, "no_such_task"));
    }
  });

  app.post("/api/tasks/:id/claim", async (c) => {
    try {
      const body = await c.req.json<{ agent: string }>();
      const claim = await claimTask(root, c.req.param("id"), body.agent);
      emit("task.claimed", { task: c.req.param("id"), claim: claim.id, agent: body.agent });
      return json(okResult(claim));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.post("/api/tasks/:id/release", async (c) => {
    try {
      const body = await c.req.json<{ agent: string }>();
      await releaseTask(root, c.req.param("id"), body.agent);
      emit("task.released", { task: c.req.param("id"), agent: body.agent });
      return json(okResult({ released: c.req.param("id") }));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.post("/api/tasks/:id/finish", async (c) => {
    try {
      const body = await c.req.json<{ agent: string }>();
      await finishTask(root, c.req.param("id"), body.agent);
      emit("task.finished", { task: c.req.param("id"), agent: body.agent });
      return json(okResult({ finished: c.req.param("id") }));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── issues ──

  app.get("/api/issues", (_c) => {
    try {
      return json(okResult(loadIssues(root)));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.post("/api/issues", async (c) => {
    try {
      const body = await c.req.json();
      const issue = await createIssue(root, body);
      emit("issue.created", { issue: issue.id, title: body.title });
      return json(okResult(issue));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── github integration ──

  app.post("/api/gh/import", async (c) => {
    try {
      const body = await c.req.json<{ repo: string }>();
      const token = process.env.GITHUB_TOKEN ?? "";
      const result = await importGitHubIssues(root, body.repo, token);
      if (result.ok) {
        emit("gh.imported", { repo: body.repo, count: result.data?.imported ?? 0 });
      }
      return json(result);
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.post("/api/gh/export", async (c) => {
    try {
      const body = await c.req.json<{ repo: string }>();
      const token = process.env.GITHUB_TOKEN ?? "";
      const result = await exportGitHubIssues(root, body.repo, token);
      if (result.ok) {
        emit("gh.exported", { repo: body.repo, count: result.data?.exported ?? 0 });
      }
      return json(result);
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── messages ──

  app.get("/api/messages", (c) => {
    const thread = c.req.query("thread");
    if (thread) {
      return json(okResult(threadMessages(root, thread)));
    }
    return json(okResult(threadMessages(root, "project")));
  });

  app.get("/api/messages/inbox/:agent", (c) => {
    const since = c.req.query("since");
    return json(okResult(inbox(root, c.req.param("agent"), since)));
  });

  app.post("/api/messages", async (c) => {
    try {
      const body = await c.req.json<{
        thread: string;
        from: string;
        to?: string;
        kind?: string;
        body: string;
      }>();
      const m = await postMessage(root, {
        thread: body.thread,
        from: body.from,
        to: body.to ?? null,
        kind: body.kind as never,
        body: body.body,
      });
      emit("message.posted", { message: m.id, thread: body.thread, from: body.from });
      return json(okResult(m));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── prompts ──

  app.get("/api/prompts", (_c) => {
    return json(okResult(loadPrompts(root)));
  });

  app.get("/api/prompts/render", (c) => {
    const taskId = c.req.query("task");
    const agent = c.req.query("agent");
    if (!taskId || !agent) {
      return json(
        toResult(null, [
          diag("unexpected_error" as never, { message: "task and agent query params required" }),
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
    const role = c.req.query("role");
    const ctx = { agent, role, task: task.id, scope: task.scope ?? undefined };
    const vars = { task_id: task.id, agent, scope: task.scope ?? undefined };
    const selected = selectPrompts(root, ctx);
    const rendered = selected.length
      ? selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n")
      : "No applicable prompts.\n";
    return json(okResult({ prompts: selected.map((p) => p.id), rendered }));
  });

  // ── handoffs ──

  app.post("/api/handoffs", async (c) => {
    try {
      const body = await c.req.json<{
        task: string;
        from: string;
        to?: string;
        summary?: string;
      }>();
      const h = await createHandoff(root, {
        task: body.task,
        from: body.from,
        to: body.to ?? null,
        summary: body.summary,
      });
      emit("handoff.created", { handoff: h.id, task: body.task, from: body.from, to: body.to });
      return json(okResult(h));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── claims ──

  app.get("/api/claims", (c) => {
    try {
      let claims = loadClaims(root);
      const status = c.req.query("status");
      if (status) claims = claims.filter((cl) => cl.status === status);
      claims.sort((a, b) => b.claimed_at.localeCompare(a.claimed_at));
      return json(okResult(claims));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── validate ──

  app.get("/api/validate", (_c) => {
    return json(validateLedger(root));
  });

  // ── git ──

  app.get("/api/git/status", async (_c) => {
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
  });

  app.get("/api/git/context", async (_c) => {
    return json(buildGitContext(root));
  });

  app.get("/api/git/diff", async (_c) => {
    try {
      const proc = Bun.spawnSync(["git", "diff", "--stat"], { cwd: root });
      const diffText = proc.stdout.toString().trim();
      const staged = Bun.spawnSync(["git", "diff", "--stat", "--cached"], { cwd: root });
      const stagedText = staged.stdout.toString().trim();
      return json(okResult({ diff: diffText || null, staged: stagedText || null }));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  app.post("/api/git/commit", async (c) => {
    try {
      const body = await c.req.json<{ message: string; files?: string[] }>();
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
        const add = Bun.spawnSync(["git", "add", "-A"], { cwd: root });
        if (add.exitCode !== 0) {
          return json(
            toResult(null, [
              diag("unexpected_error" as never, {
                message: add.stderr.toString().trim() || "git add failed",
              }),
            ]),
          );
        }
      }
      const proc = Bun.spawnSync(["git", "commit", "-m", body.message], { cwd: root });
      const out = proc.stdout.toString().trim();
      const err = proc.stderr.toString().trim();
      if (proc.exitCode !== 0) {
        return json(
          toResult(null, [diag("unexpected_error" as never, { message: err || "commit failed" })]),
        );
      }
      return json(okResult({ output: out || "committed" }));
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── reindex ──

  app.post("/api/reindex", async (_c) => {
    try {
      const result = await reindex(root);
      return json(result);
    } catch (e) {
      return json(catchDiag(e));
    }
  });

  // ── SSE ──

  app.get("/api/events", (c) => {
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
        c.req.raw.signal.addEventListener("abort", () => {
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
  });

  // ── static SPA (production) ──

  app.get("/graphify-out/*", async (c) => {
    const target = fileWithin(join(root, "graphify-out"), join(root, c.req.path));
    if (!target) return c.notFound();
    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);
    return c.notFound();
  });

  if (distDir) {
    app.get("/assets/*", async (c) => {
      const target = fileWithin(join(distDir, "assets"), join(distDir, c.req.path));
      if (!target) return c.notFound();
      const file = Bun.file(target);
      if (await file.exists()) return new Response(file);
      return c.notFound();
    });
    app.get("/favicon.ico", async (c) => {
      const file = Bun.file(join(distDir, "favicon.ico"));
      if (await file.exists()) return new Response(file);
      return c.notFound();
    });
    app.get("*", async (c) => {
      const file = Bun.file(join(distDir, "index.html"));
      if (await file.exists())
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      return c.notFound();
    });
  } else {
    app.get("/", (c) => {
      return c.html("<h1>Waystation Dashboard</h1><p>API ready. Use --dev for the SPA.</p>");
    });
  }

  return app;
}
