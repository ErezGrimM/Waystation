#!/usr/bin/env bun
import { Command } from "commander";
import { type BriefBudget, buildBrief, renderBrief } from "../core/brief.ts";
import { generateReports, generateTaskViews, reindex } from "../core/generate.ts";
import { inbox, postMessage, threadMessages } from "../core/messages.ts";
import { claimTask, finishTask, MutationError, releaseTask } from "../core/mutate.ts";
import { findProjectRoot, ledgerPaths } from "../core/paths.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { CODES } from "../core/result.ts";
import { nextTask, readyTasks } from "../core/tasks.ts";
import { validateLedger } from "../core/validate.ts";
import { buildTaskIndex, readyFromIndex } from "../index/taskIndex.ts";

const program = new Command();

program
  .name("waystation")
  .description("Local-first ledger for coordinating humans and AI coding agents")
  .version("0.0.1");

const task = program.command("task").description("Task commands");

task
  .command("next")
  .description("Show the next ready task (highest priority, all dependencies done)")
  .option("--json", "output JSON")
  .option("--from-index", "resolve via the SQLite index instead of in-memory")
  .action(async (opts: { json?: boolean; fromIndex?: boolean }) => {
    const tasks = loadTasks();

    if (opts.fromIndex) {
      const paths = ledgerPaths();
      const db = await buildTaskIndex(paths.index, tasks);
      const ready = readyFromIndex(db);
      db.close();
      const chosen = ready[0] ?? null;
      emitNext(chosen, opts.json);
      return;
    }

    emitNext(nextTask(tasks), opts.json);
  });

task
  .command("ready")
  .description("List all ready tasks, best-first")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const ready = readyTasks(loadTasks());
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(ready, null, 2)}\n`);
      return;
    }
    if (ready.length === 0) {
      process.stdout.write("No ready tasks.\n");
      return;
    }
    for (const t of ready) {
      process.stdout.write(`${t.id}  [p${t.priority}]  ${t.title}\n`);
    }
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
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
      return;
    }
    if (tasks.length === 0) {
      process.stdout.write("No tasks.\n");
      return;
    }
    for (const t of tasks) {
      process.stdout.write(`${t.id}  [p${t.priority}]  ${t.status.padEnd(11)}  ${t.title}\n`);
    }
  });

task
  .command("show")
  .argument("<id>", "task id")
  .description("Show a single task")
  .option("--json", "output JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const found = loadTasks().find((t) => t.id === id);
    if (!found) {
      process.stderr.write(`error: no such task: ${id}\n`);
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
      return;
    }
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

task
  .command("claim")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "claiming agent")
  .description("Claim a task (creates an active claim, moves task to in_progress)")
  .action(async (id: string, opts: { agent: string }) => {
    const claim = await claimTask(findProjectRoot(), id, opts.agent);
    process.stdout.write(`claimed ${id} as ${claim.id}\n`);
  });

task
  .command("release")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "releasing agent")
  .description("Release the active claim on a task (moves task back to ready)")
  .action(async (id: string, opts: { agent: string }) => {
    await releaseTask(findProjectRoot(), id, opts.agent);
    process.stdout.write(`released ${id}\n`);
  });

task
  .command("finish")
  .argument("<id>", "task id")
  .requiredOption("--agent <agent>", "finishing agent")
  .description("Finish a task (marks it done and completes any active claim)")
  .action(async (id: string, opts: { agent: string }) => {
    await finishTask(findProjectRoot(), id, opts.agent);
    process.stdout.write(`finished ${id}\n`);
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
      process.stdout.write(opts.json ? `${JSON.stringify(brief, null, 2)}\n` : renderBrief(brief));
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exit(1);
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
  .action(async () => {
    const c = await reindex(findProjectRoot());
    process.stdout.write(
      `reindexed ${c.tasks} tasks, ${c.issues} issues, ${c.claims} claims, ${c.messages} messages\n`,
    );
  });

program
  .command("report")
  .description(
    "Regenerate STATUS.md and context files (active-work.md, blocked.md) from the ledger",
  )
  .option("--views", "also regenerate views/tasks/*.md")
  .action((opts: { views?: boolean }) => {
    const root = findProjectRoot();
    const written = generateReports(root);
    if (opts.views) {
      const n = generateTaskViews(root);
      written.push(`views/tasks/ (${n} files)`);
    }
    for (const f of written) process.stdout.write(`generated ${f}\n`);
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

function emitNext(
  chosen: { id: string; title: string; priority: number } | null,
  asJson?: boolean,
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(chosen, null, 2)}\n`);
    return;
  }
  if (!chosen) {
    process.stdout.write("No ready tasks.\n");
    return;
  }
  process.stdout.write(`${chosen.id}  [p${chosen.priority}]  ${chosen.title}\n`);
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof RecordError || err instanceof MutationError) {
    const code = err.code;
    const spec = code in CODES ? CODES[code as keyof typeof CODES] : undefined;
    process.stderr.write(`error [${code}]: ${err.message}\n`);
    if (spec?.hint) process.stderr.write(`  hint: ${spec.hint}\n`);
    process.exit(1);
  }
  throw err;
}
