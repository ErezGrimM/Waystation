#!/usr/bin/env bun
import { Command } from "commander";
import { type BriefBudget, buildBrief, renderBrief } from "../core/brief.ts";
import { generateReports, generateTaskViews, reindex } from "../core/generate.ts";
import { type GitState, getGitState } from "../core/git.ts";
import { createHandoff, getHandoff } from "../core/handoff.ts";
import { initLedger } from "../core/init.ts";
import { inbox, postMessage, threadMessages } from "../core/messages.ts";
import { claimTask, finishTask, MutationError, releaseTask } from "../core/mutate.ts";
import { findProjectRoot, ledgerPaths } from "../core/paths.ts";
import { getPrompt, loadPrompts, renderPrompt, selectPrompts } from "../core/prompt.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { CODES, type CommandResult, diag, okResult, toResult } from "../core/result.ts";
import { nextTask, readyTasks } from "../core/tasks.ts";
import { validateLedger } from "../core/validate.ts";
import { backendWarnings } from "../index/ledgerIndex.ts";
import { buildTaskIndex, readyFromIndex } from "../index/taskIndex.ts";

const program = new Command();

program
  .name("waystation")
  .description("Local-first ledger for coordinating humans and AI coding agents")
  .version("0.0.1");

program
  .command("init")
  .description("Scaffold a new .waystation/ ledger in the current directory")
  .option("--project <id>", "project id (default: folder name)")
  .option("--force", "reinitialize even if a ledger exists")
  .option("--json", "output JSON")
  .action(async (opts: { project?: string; force?: boolean; json?: boolean }) => {
    const res = await initLedger(process.cwd(), { project: opts.project, force: opts.force });
    emitResult(res, opts.json, () => {
      const r = res.data;
      if (r?.created) process.stdout.write(`initialized ${r.root} (project: ${r.project})\n`);
      else process.stdout.write("already initialized (use --force to reinitialize)\n");
    });
  });

const task = program.command("task").description("Task commands");

task
  .command("next")
  .description("Show the next ready task (highest priority, all dependencies done)")
  .option("--json", "output JSON")
  .option("--from-index", "resolve via the SQLite index instead of in-memory")
  .action(async (opts: { json?: boolean; fromIndex?: boolean }) => {
    const tasks = loadTasks();
    const line = (t: { id: string; title: string; priority: number } | null) =>
      process.stdout.write(t ? `${t.id}  [p${t.priority}]  ${t.title}\n` : "No ready tasks.\n");

    if (opts.fromIndex) {
      const db = await buildTaskIndex(ledgerPaths().index, tasks);
      const ready = readyFromIndex(db);
      const warnings = backendWarnings(db.backend);
      db.close();
      const chosen = ready[0] ?? null;
      emitResult(okResult(chosen, warnings), opts.json, () => line(chosen));
      return;
    }
    const chosen = nextTask(tasks);
    emitResult(okResult(chosen), opts.json, () => line(chosen));
  });

task
  .command("ready")
  .description("List all ready tasks, best-first")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const ready = readyTasks(loadTasks());
    emitResult(okResult(ready), opts.json, () => {
      if (ready.length === 0) {
        process.stdout.write("No ready tasks.\n");
        return;
      }
      for (const t of ready) process.stdout.write(`${t.id}  [p${t.priority}]  ${t.title}\n`);
    });
  });

task
  .command("list")
  .description("List all tasks with their status")
  .option("--json", "output JSON")
  .option("--status <status>", "filter by status")
  .action((opts: { json?: boolean; status?: string }) => {
    let tasks = loadTasks();
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    tasks.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    emitResult(okResult(tasks), opts.json, () => {
      if (tasks.length === 0) {
        process.stdout.write("No tasks.\n");
        return;
      }
      for (const t of tasks) {
        process.stdout.write(`${t.id}  [p${t.priority}]  ${t.status.padEnd(11)}  ${t.title}\n`);
      }
    });
  });

task
  .command("show")
  .argument("<id>", "task id")
  .description("Show a single task")
  .option("--json", "output JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const found = loadTasks().find((t) => t.id === id) ?? null;
    const res = found
      ? okResult(found)
      : toResult(null, [diag("no_such_task", { message: `no such task: ${id}`, details: { id } })]);
    emitResult(res, opts.json, () => {
      if (!found) return;
      process.stdout.write(`${found.id}\n`);
      process.stdout.write(`  title:        ${found.title}\n`);
      process.stdout.write(`  status:       ${found.status}\n`);
      process.stdout.write(`  priority:     ${found.priority}\n`);
      if (found.scope) process.stdout.write(`  scope:        ${found.scope}\n`);
      if (found.dependencies.length) {
        process.stdout.write(`  dependencies: ${found.dependencies.join(", ")}\n`);
      }
      if (found.description) process.stdout.write(`\n${found.description.trimEnd()}\n`);
    });
  });

task
  .command("claim")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "claiming agent")
  .option("--branch <branch>", "git branch to record on the claim")
  .option("--worktree <path>", "git worktree path to record on the claim")
  .option("--json", "output JSON")
  .description("Claim a task (creates an active claim, moves task to in_progress)")
  .action(
    async (
      id: string,
      opts: { agent: string; branch?: string; worktree?: string; json?: boolean },
    ) => {
      await runMutation(opts.json, async () => {
        const claim = await claimTask(findProjectRoot(), id, opts.agent, new Date(), {
          branch: opts.branch,
          worktree: opts.worktree,
        });
        return `claimed ${id} as ${claim.id}`;
      });
    },
  );

task
  .command("release")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "releasing agent")
  .option("--json", "output JSON")
  .description("Release the active claim on a task (moves task back to ready)")
  .action(async (id: string, opts: { agent: string; json?: boolean }) => {
    await runMutation(opts.json, async () => {
      await releaseTask(findProjectRoot(), id, opts.agent);
      return `released ${id}`;
    });
  });

task
  .command("finish")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "finishing agent")
  .option("--json", "output JSON")
  .description("Finish a task (marks it done and completes any active claim)")
  .action(async (id: string, opts: { agent: string; json?: boolean }) => {
    await runMutation(opts.json, async () => {
      await finishTask(findProjectRoot(), id, opts.agent);
      return `finished ${id}`;
    });
  });

program
  .command("brief")
  .description("Generate a task-scoped context brief")
  .requiredOption("--task <id>", "task id")
  .option("--budget <budget>", "small|medium|large|full", "medium")
  .option("--json", "output JSON")
  .action((opts: { task: string; budget: string; json?: boolean }) => {
    try {
      const brief = buildBrief(findProjectRoot(), opts.task, opts.budget as BriefBudget);
      emitResult(okResult(brief), opts.json, () => process.stdout.write(renderBrief(brief)));
    } catch (e) {
      // A plain "not found" maps to no_such_task; a RecordError surfaces its
      // real code (e.g. a corrupt task file) instead of being mislabeled.
      const code = e instanceof RecordError || e instanceof MutationError ? e.code : "no_such_task";
      const res = toResult(null, [
        diag(code as never, { message: (e as Error).message, details: { task: opts.task } }),
      ]);
      emitResult(res, opts.json, () => {});
    }
  });

program
  .command("validate")
  .description("Validate the ledger (schemas, references, cycles, claims, events)")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const res = validateLedger(findProjectRoot());
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.ok && res.warnings.length === 0) {
      process.stdout.write("ok: no problems found.\n");
    } else {
      for (const d of res.errors) process.stdout.write(`ERROR [${d.code}] ${d.message}\n`);
      for (const d of res.warnings) process.stdout.write(`WARNING [${d.code}] ${d.message}\n`);
      process.stdout.write(`\n${res.errors.length} error(s), ${res.warnings.length} warning(s)\n`);
    }
    if (!res.ok) process.exit(1);
  });

program
  .command("reindex")
  .description("Rebuild the SQLite index from canonical records")
  .option("--json", "output JSON")
  .action(async (opts: { json?: boolean }) => {
    const res = await reindex(findProjectRoot());
    emitResult(res, opts.json, () => {
      const c = res.data;
      if (c) {
        process.stdout.write(
          `reindexed ${c.tasks} tasks, ${c.issues} issues, ${c.claims} claims, ${c.messages} messages\n`,
        );
      }
    });
  });

program
  .command("report")
  .description(
    "Regenerate STATUS.md and context files (active-work.md, blocked.md) from the ledger",
  )
  .option("--views", "also regenerate views/tasks/*.md")
  .option("--json", "output JSON")
  .action((opts: { views?: boolean; json?: boolean }) => {
    const root = findProjectRoot();
    const written = generateReports(root);
    if (opts.views) {
      const n = generateTaskViews(root);
      written.push(`views/tasks/ (${n} files)`);
    }
    emitResult(okResult({ written }), opts.json, () => {
      for (const f of written) process.stdout.write(`generated ${f}\n`);
    });
  });

const handoff = program.command("handoff").description("Agent handoffs (baton pass)");

handoff
  .command("create")
  .description("Create a handoff for a task")
  .requiredOption("--task <id>", "task id")
  .requiredOption("--from <agent>", "handing-off agent")
  .option("--to <agent>", "receiving agent (omit for next available)")
  .option("--summary <text>", "summary of current state")
  .option("--json", "output JSON")
  .action(
    async (opts: { task: string; from: string; to?: string; summary?: string; json?: boolean }) => {
      await runMutation(opts.json, async () => {
        const h = await createHandoff(findProjectRoot(), {
          task: opts.task,
          from: opts.from,
          to: opts.to ?? null,
          summary: opts.summary,
        });
        return `created ${h.id}`;
      });
    },
  );

handoff
  .command("show")
  .argument("<id>", "handoff id")
  .option("--json", "output JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const h = getHandoff(findProjectRoot(), id) ?? null;
    const res = h
      ? okResult(h)
      : toResult(null, [diag("not_found", { message: `no such handoff: ${id}`, details: { id } })]);
    emitResult(res, opts.json, () => {
      if (!h) return;
      process.stdout.write(`${h.id}\n`);
      process.stdout.write(`  task:    ${h.task}\n`);
      process.stdout.write(`  from:    ${h.from_agent}${h.to_agent ? ` -> ${h.to_agent}` : ""}\n`);
      if (h.summary) process.stdout.write(`\n${h.summary.trimEnd()}\n`);
      if (h.next_steps.length) {
        process.stdout.write(`\nnext steps:\n${h.next_steps.map((s) => `  - ${s}`).join("\n")}\n`);
      }
    });
  });

const prompt = program.command("prompt").description("Prompt records");

prompt
  .command("list")
  .description("List prompt records")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const prompts = loadPrompts(findProjectRoot());
    emitResult(okResult(prompts), opts.json, () => {
      if (prompts.length === 0) {
        process.stdout.write("No prompts.\n");
        return;
      }
      for (const p of prompts) process.stdout.write(`${p.id}  [${p.status}]  ${p.title}\n`);
    });
  });

prompt
  .command("show")
  .argument("<id>", "prompt id")
  .option("--json", "output JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const p = getPrompt(findProjectRoot(), id) ?? null;
    const res = p
      ? okResult(p)
      : toResult(null, [diag("not_found", { message: `no such prompt: ${id}`, details: { id } })]);
    emitResult(res, opts.json, () => {
      if (p) process.stdout.write(renderPrompt(p, {}));
    });
  });

prompt
  .command("render")
  .description("Render applicable prompts for a task/agent (spec §11)")
  .requiredOption("--task <id>", "task id")
  .requiredOption("--agent <agent>", "agent name")
  .option("--role <role>", "agent role")
  .option("--json", "output JSON")
  .action((opts: { task: string; agent: string; role?: string; json?: boolean }) => {
    const root = findProjectRoot();
    const task = loadTasks(root).find((t) => t.id === opts.task);
    if (!task) {
      emitResult(
        toResult(null, [
          diag("no_such_task", {
            message: `no such task: ${opts.task}`,
            details: { id: opts.task },
          }),
        ]),
        opts.json,
        () => {},
      );
      return;
    }
    const ctx = {
      agent: opts.agent,
      role: opts.role,
      task: task.id,
      scope: task.scope ?? undefined,
    };
    const vars = { task_id: task.id, agent: opts.agent, scope: task.scope ?? undefined };
    const selected = selectPrompts(root, ctx);
    const rendered = selected.length
      ? selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n")
      : "No applicable prompts.\n";
    emitResult(okResult({ prompts: selected.map((p) => p.id), rendered }), opts.json, () =>
      process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`),
    );
  });

const message = program.command("message").description("Agent messages (async inbox)");

message
  .command("post")
  .description("Post a message to a thread (a task/issue id or 'project')")
  .requiredOption("--thread <id>", "task/issue id, or 'project' for the folder-wide channel")
  .requiredOption("--from <agent>", "author")
  .option("--to <agent>", "recipient; omit to broadcast to the thread")
  .option("--kind <kind>", "update|question|verdict|note", "update")
  .requiredOption("--body <text>", "message body")
  .option("--in-reply-to <id>", "message id this replies to")
  .action(
    async (opts: {
      thread: string;
      from: string;
      to?: string;
      kind: string;
      body: string;
      inReplyTo?: string;
    }) => {
      try {
        const m = await postMessage(findProjectRoot(), {
          thread: opts.thread,
          from: opts.from,
          to: opts.to ?? null,
          kind: opts.kind as never,
          body: opts.body,
          inReplyTo: opts.inReplyTo ?? null,
        });
        process.stdout.write(`posted ${m.id}\n`);
      } catch (e) {
        process.stderr.write(`error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    },
  );

message
  .command("list")
  .description("List messages on a thread, oldest first")
  .requiredOption("--thread <id>", "thread id")
  .option("--json", "output JSON")
  .action((opts: { thread: string; json?: boolean }) => {
    const msgs = threadMessages(findProjectRoot(), opts.thread);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(msgs, null, 2)}\n`);
      return;
    }
    if (msgs.length === 0) {
      process.stdout.write("No messages.\n");
      return;
    }
    for (const m of msgs) process.stdout.write(renderMessage(m));
  });

program
  .command("inbox")
  .description("Show messages addressed to an agent (direct, project channel, or claimed threads)")
  .requiredOption("--agent <agent>", "agent whose inbox to read")
  .option("--since <cursor>", "ISO timestamp; only messages after it")
  .option("--json", "output JSON")
  .action((opts: { agent: string; since?: string; json?: boolean }) => {
    const msgs = inbox(findProjectRoot(), opts.agent, opts.since);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(msgs, null, 2)}\n`);
      return;
    }
    if (msgs.length === 0) {
      process.stdout.write("Inbox empty.\n");
      return;
    }
    for (const m of msgs) process.stdout.write(renderMessage(m));
  });

const git = program.command("git").description("Git/worktree commands");

git
  .command("status")
  .description("Show current git branch, worktree, and status summary")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const res = getGitState(findProjectRoot());
    emitResult(res, opts.json, () => {
      const state = res.data;
      if (!state) return;
      process.stdout.write(renderGitState(state));
    });
  });

function renderMessage(m: {
  from_agent: string;
  to_agent?: string | null;
  thread: string;
  kind: string;
  body: string;
  created_at: string;
}): string {
  const to = m.to_agent ? `→${m.to_agent}` : "→(all)";
  return `[${m.kind}] ${m.from_agent}${to} (${m.thread}) ${m.created_at}\n  ${m.body}\n`;
}

function renderGitState(state: GitState): string {
  const branch = state.branch ?? `(detached${state.head ? ` at ${state.head}` : ""})`;
  return [
    `branch:    ${branch}`,
    `worktree:  ${state.worktree}`,
    `root:      ${state.root}`,
    `changed:   ${state.status.changed}`,
    `staged:    ${state.status.staged}`,
    `unstaged:  ${state.status.unstaged}`,
    `untracked: ${state.status.untracked}`,
    "",
  ].join("\n");
}

/** Emit a CommandResult: JSON envelope with --json, else human text + any
 * warnings/errors on stderr. Exits non-zero when the result is not ok. */
function emitResult<T>(
  res: CommandResult<T>,
  json: boolean | undefined,
  renderText: () => void,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    renderText();
    for (const w of res.warnings) process.stderr.write(`warning [${w.code}] ${w.message}\n`);
    for (const e of res.errors) process.stderr.write(`error [${e.code}] ${e.message}\n`);
  }
  if (!res.ok) process.exit(1);
}

/** Run a mutation, emitting a CommandResult. MutationError/RecordError map to
 * their code; anything else to unexpected_error. */
async function runMutation(json: boolean | undefined, fn: () => Promise<string>): Promise<void> {
  try {
    const msg = await fn();
    emitResult(okResult({ message: msg }), json, () => process.stdout.write(`${msg}\n`));
  } catch (e) {
    const code =
      e instanceof MutationError || e instanceof RecordError ? e.code : "unexpected_error";
    emitResult(
      toResult(null, [diag(code as never, { message: (e as Error).message })]),
      json,
      () => {},
    );
  }
}

program
  .command("mcp")
  .description("Start an MCP stdio server for coding agent integration")
  .action(async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { buildServer } = await import("../mcp/server.ts");
    const root = findProjectRoot();
    const server = buildServer(root);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program
  .command("dashboard")
  .description("Start the local dashboard web UI (http://127.0.0.1:8787)")
  .option("--dev", "start Vite dev server alongside and proxy to it")
  .option("--port <port>", "port", "8787")
  .action(async (opts: { dev?: boolean; port: string }) => {
    const { createApp } = await import("../dashboard/server.ts");
    const { join } = await import("node:path");
    const root = findProjectRoot();
    const distDir = join(root, "src", "dashboard", "client", "dist");
    const app = createApp(root, opts.dev ? undefined : distDir);
    const port = Number(opts.port);

    if (opts.dev) {
      const vitePort = 5173;
      const _viteProc = Bun.spawn(
        ["bun", "x", "vite", "--port", String(vitePort), "--strictPort"],
        {
          cwd: root,
          stdio: ["ignore", "inherit", "inherit"],
        },
      );

      app.use("*", async (c, next) => {
        if (c.req.path.startsWith("/api/")) return next();
        const target = `http://127.0.0.1:${vitePort}${c.req.path}`;
        const res = await fetch(target);
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      });

      process.stderr.write(`Vite dev server on http://127.0.0.1:${vitePort}\n`);
      process.stderr.write(`Dashboard on http://127.0.0.1:${port}\n`);
    }

    process.stderr.write(`Waystation dashboard listening on http://127.0.0.1:${port}\n`);
    Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Convert ANY error into a coded diagnostic line (no raw stack dump).
  const code =
    err instanceof RecordError || err instanceof MutationError ? err.code : "unexpected_error";
  const spec = code in CODES ? CODES[code as keyof typeof CODES] : undefined;
  process.stderr.write(`error [${code}]: ${(err as Error).message}\n`);
  if (spec?.hint) process.stderr.write(`  hint: ${spec.hint}\n`);
  process.exit(1);
}
