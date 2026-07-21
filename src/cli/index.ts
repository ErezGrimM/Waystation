#!/usr/bin/env bun
import { Command } from "commander";
import { ZodError } from "zod";
import {
  buildBriefResult,
  configuredBriefBudget,
  parseBriefBudget,
  renderBrief,
  resolveTaskFromGitClaim,
} from "../core/brief.ts";
import { generateReports, generateTaskViews, reindex } from "../core/generate.ts";
import { type GitState, getGitState } from "../core/git.ts";
import { createHandoff, getHandoff } from "../core/handoff.ts";
import { initLedger } from "../core/init.ts";
import {
  type CreateIssueInput,
  closeIssue,
  createIssue,
  type UpdateIssueInput,
  updateIssue,
} from "../core/issue.ts";
import { inbox, postMessage, threadMessages } from "../core/messages.ts";
import {
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
import { findProjectRoot, LedgerResolutionError, ledgerPaths } from "../core/paths.ts";
import { getPrompt, loadPrompts, renderPrompt, selectPrompts } from "../core/prompt.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { CODES, type CommandResult, diag, okResult, toResult } from "../core/result.ts";
import type { IssueRecord, TaskStatus } from "../core/schema.ts";
import { loadIssues } from "../core/store.ts";
import { syncLedger } from "../core/sync.ts";
import { nextTask, readyTasks } from "../core/tasks.ts";
import { validateLedger } from "../core/validate.ts";
import { backendWarnings } from "../index/ledgerIndex.ts";
import { buildTaskIndex, readyFromIndex } from "../index/taskIndex.ts";

const program = new Command();

program
  .name("waystation")
  .description("Local-first ledger for coordinating humans and AI coding agents")
  .option("--root <path>", "ledger root (overrides WAYSTATION_ROOT and upward discovery)")
  .version("0.1.0");

// Keep root selection in the core resolver, but make the CLI's explicit flag
// available to every subcommand without duplicating root plumbing.
program.hook("preAction", (_command, action) => {
  if (action.name() === "init") return;
  const root = action.optsWithGlobals().root as string | undefined;
  if (root) process.env.WAYSTATION_ROOT = root;
});

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
  .description("Show the next declared-ready task whose dependencies are done or wont_do")
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
  .description("List actionable declared-ready tasks, best-first")
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
      if (found.commits.length) {
        process.stdout.write(`  commits:      ${found.commits.join(", ")}\n`);
      }
      if (found.description) process.stdout.write(`\n${found.description.trimEnd()}\n`);
    });
  });

task
  .command("create")
  .argument("<id>", "task id")
  .requiredOption("--title <title>", "task title")
  .option("--status <status>", "initial status", "todo")
  .option("--priority <number>", "numeric priority", "3")
  .option("--scope <id>", "scope id")
  .option("--path-hint <path...>", "path hint(s)")
  .option("--prompt <id...>", "prompt id(s)")
  .option("--depends-on <id...>", "dependency task id(s)")
  .option("--description <text>", "task description")
  .option("--acceptance <text...>", "acceptance criterion/criteria")
  .option("--notes <text>", "coordination notes")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Create a task through the canonical core mutation path")
  .action(
    async (
      id: string,
      opts: {
        title: string;
        status: string;
        priority: string;
        scope?: string;
        pathHint?: string[];
        prompt?: string[];
        dependsOn?: string[];
        description?: string;
        acceptance?: string[];
        notes?: string;
        actor: string;
        json?: boolean;
      },
    ) => {
      await runCommand(
        opts.json,
        () =>
          createTask(
            findProjectRoot(),
            {
              id,
              title: opts.title,
              status: opts.status as TaskStatus,
              priority: parsePriority(opts.priority) ?? 3,
              scope: opts.scope ?? null,
              path_hints: opts.pathHint ?? [],
              prompts: opts.prompt ?? [],
              dependencies: opts.dependsOn ?? [],
              description: opts.description,
              acceptance: opts.acceptance ?? [],
              notes: opts.notes,
            },
            opts.actor,
          ),
        (created) => process.stdout.write(`created ${created.id} (${created.status})\n`),
      );
    },
  );

task
  .command("update")
  .argument("<id>", "task id")
  .option("--title <title>", "task title")
  .option("--priority <number>", "numeric priority")
  .option("--scope <id>", "scope id")
  .option("--path-hint <path...>", "replace path hints")
  .option("--prompt <id...>", "replace prompt ids")
  .option("--depends-on <id...>", "replace dependency task ids")
  .option("--description <text>", "task description")
  .option("--acceptance <text...>", "replace acceptance criteria")
  .option("--notes <text>", "coordination notes")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Update mutable task fields without changing lifecycle status")
  .action(
    async (
      id: string,
      opts: {
        title?: string;
        priority?: string;
        scope?: string;
        pathHint?: string[];
        prompt?: string[];
        dependsOn?: string[];
        description?: string;
        acceptance?: string[];
        notes?: string;
        actor: string;
        json?: boolean;
      },
    ) => {
      await runCommand(
        opts.json,
        () => {
          const patch: TaskPatch = {};
          if (opts.title !== undefined) patch.title = opts.title;
          if (opts.priority !== undefined) {
            const priority = parsePriority(opts.priority);
            if (priority !== undefined) patch.priority = priority;
          }
          if (opts.scope !== undefined) patch.scope = opts.scope;
          if (opts.pathHint !== undefined) patch.path_hints = opts.pathHint;
          if (opts.prompt !== undefined) patch.prompts = opts.prompt;
          if (opts.dependsOn !== undefined) patch.dependencies = opts.dependsOn;
          if (opts.description !== undefined) patch.description = opts.description;
          if (opts.acceptance !== undefined) patch.acceptance = opts.acceptance;
          if (opts.notes !== undefined) patch.notes = opts.notes;
          requirePatch(patch, "task");
          return updateTask(findProjectRoot(), id, patch, opts.actor);
        },
        (updated) => process.stdout.write(`updated ${updated.id}\n`),
      );
    },
  );

task
  .command("set-status")
  .argument("<id>", "task id")
  .argument("<status>", "target task status")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Apply a valid non-claim task status transition")
  .action(async (id: string, status: string, opts: { actor: string; json?: boolean }) => {
    await runCommand(
      opts.json,
      () => setTaskStatus(findProjectRoot(), id, status as TaskStatus, opts.actor),
      (updated) => process.stdout.write(`${updated.id} status: ${updated.status}\n`),
    );
  });

task
  .command("reopen")
  .argument("<id>", "task id")
  .requiredOption("--status <status>", "reopened status: todo or ready")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Reopen a done or wont_do task")
  .action(async (id: string, opts: { status: string; actor: string; json?: boolean }) => {
    if (opts.status !== "todo" && opts.status !== "ready") {
      emitResult(
        toResult(null, [
          diag("schema_invalid", { message: "reopen status must be todo or ready" }),
        ]),
        opts.json,
        () => {},
      );
      return;
    }
    await runCommand(
      opts.json,
      () => reopenTask(findProjectRoot(), id, opts.status as "todo" | "ready", opts.actor),
      (updated) => process.stdout.write(`reopened ${updated.id} as ${updated.status}\n`),
    );
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
          caller: process.cwd(),
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
  .option("--commit <sha...>", "commit hash(es) to attach to the task")
  .option("--commit-head", "attach the current git HEAD commit")
  .option("--json", "output JSON")
  .description("Finish a task (marks it done and completes any active claim)")
  .action(
    async (
      id: string,
      opts: { agent: string; commit?: string[]; commitHead?: boolean; json?: boolean },
    ) => {
      await runMutation(opts.json, async () => {
        await finishTask(findProjectRoot(), id, opts.agent, new Date(), {
          commits: opts.commit ?? [],
          commitHead: opts.commitHead,
        });
        return `finished ${id}`;
      });
    },
  );

const issue = program.command("issue").description("Issue commands");

issue
  .command("list")
  .description("List issue records")
  .option("--status <status>", "filter by status")
  .option("--json", "output JSON")
  .action(async (opts: { status?: string; json?: boolean }) => {
    await runCommand(
      opts.json,
      async () => {
        let issues = loadIssues();
        if (opts.status) issues = issues.filter((item) => item.status === opts.status);
        return issues.sort((a, b) => a.id.localeCompare(b.id));
      },
      (issues) => {
        if (issues.length === 0) {
          process.stdout.write("No issues.\n");
          return;
        }
        for (const item of issues) {
          process.stdout.write(`${item.id}  ${item.status.padEnd(11)}  ${item.title}\n`);
        }
      },
    );
  });

issue
  .command("show")
  .argument("<id>", "issue id")
  .description("Show a single issue and its preserved context")
  .option("--json", "output JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    await runCommand(
      opts.json,
      async () => {
        const found = loadIssues().find((item) => item.id === id);
        if (!found) throw new MutationError(`no such issue: ${id}`, "not_found");
        return found;
      },
      (found) => process.stdout.write(renderIssue(found)),
    );
  });

issue
  .command("create")
  .requiredOption("--title <title>", "issue title")
  .option("--id <id>", "explicit issue id")
  .option("--status <status>", "initial status")
  .option("--severity <severity>", "issue severity")
  .option("--type <type>", "issue type")
  .option("--priority <number>", "numeric priority")
  .option("--task <id>", "linked task id")
  .option("--scope <id>", "scope id")
  .option("--description <text>", "issue description")
  .option("--evidence <text>", "textual evidence")
  .option("--expected <text>", "expected behavior")
  .option("--actual <text>", "actual behavior")
  .option("--acceptance <text...>", "acceptance criterion/criteria")
  .option("--resolution <text>", "resolution text")
  .option("--notes <text>", "issue notes")
  .option("--source <json>", "source metadata as JSON")
  .option("--json", "output JSON")
  .description("Create an issue through the canonical core mutation path")
  .action(
    async (opts: {
      id?: string;
      title: string;
      status?: string;
      severity?: string;
      type?: string;
      priority?: string;
      task?: string;
      scope?: string;
      description?: string;
      evidence?: string;
      expected?: string;
      actual?: string;
      acceptance?: string[];
      resolution?: string;
      notes?: string;
      source?: string;
      json?: boolean;
    }) => {
      await runCommand(
        opts.json,
        () => {
          const input: CreateIssueInput = {
            id: opts.id,
            title: opts.title,
            status: opts.status,
            severity: opts.severity,
            type: opts.type,
            priority: parsePriority(opts.priority),
            task: opts.task,
            scope: opts.scope,
            description: opts.description,
            evidence: opts.evidence,
            expected: opts.expected,
            actual: opts.actual,
            acceptance: opts.acceptance,
            resolution: opts.resolution,
            notes: opts.notes,
            source: parseJsonValue(opts.source),
          };
          return createIssue(findProjectRoot(), input);
        },
        (created) => process.stdout.write(`created ${created.id} (${created.status})\n`),
      );
    },
  );

issue
  .command("update")
  .argument("<id>", "issue id")
  .option("--title <title>", "issue title")
  .option("--status <status>", "issue status")
  .option("--severity <severity>", "issue severity")
  .option("--type <type>", "issue type")
  .option("--priority <number>", "numeric priority")
  .option("--task <id>", "linked task id")
  .option("--scope <id>", "scope id")
  .option("--description <text>", "issue description")
  .option("--evidence <text>", "textual evidence")
  .option("--expected <text>", "expected behavior")
  .option("--actual <text>", "actual behavior")
  .option("--acceptance <text...>", "replace acceptance criteria")
  .option("--resolution <text>", "resolution text")
  .option("--notes <text>", "issue notes")
  .option("--source <json>", "source metadata as JSON")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Update mutable issue fields")
  .action(
    async (
      id: string,
      opts: {
        title?: string;
        status?: string;
        severity?: string;
        type?: string;
        priority?: string;
        task?: string;
        scope?: string;
        description?: string;
        evidence?: string;
        expected?: string;
        actual?: string;
        acceptance?: string[];
        resolution?: string;
        notes?: string;
        source?: string;
        actor: string;
        json?: boolean;
      },
    ) => {
      await runCommand(
        opts.json,
        () => {
          const patch: UpdateIssueInput = {};
          if (opts.title !== undefined) patch.title = opts.title;
          if (opts.status !== undefined) patch.status = opts.status;
          if (opts.severity !== undefined) patch.severity = opts.severity;
          if (opts.type !== undefined) patch.type = opts.type;
          if (opts.priority !== undefined) {
            const priority = parsePriority(opts.priority);
            if (priority !== undefined) patch.priority = priority;
          }
          if (opts.task !== undefined) patch.task = opts.task;
          if (opts.scope !== undefined) patch.scope = opts.scope;
          if (opts.description !== undefined) patch.description = opts.description;
          if (opts.evidence !== undefined) patch.evidence = opts.evidence;
          if (opts.expected !== undefined) patch.expected = opts.expected;
          if (opts.actual !== undefined) patch.actual = opts.actual;
          if (opts.acceptance !== undefined) patch.acceptance = opts.acceptance;
          if (opts.resolution !== undefined) patch.resolution = opts.resolution;
          if (opts.notes !== undefined) patch.notes = opts.notes;
          if (opts.source !== undefined) patch.source = parseJsonValue(opts.source);
          requirePatch(patch, "issue");
          return updateIssue(findProjectRoot(), id, patch, opts.actor);
        },
        (updated) => process.stdout.write(`updated ${updated.id}\n`),
      );
    },
  );

issue
  .command("close")
  .argument("<id>", "issue id")
  .requiredOption("--resolution <text>", "resolution summary")
  .option("--actor <actor>", "mutation actor", "cli")
  .option("--json", "output JSON")
  .description("Close an issue with a resolution")
  .action(async (id: string, opts: { resolution: string; actor: string; json?: boolean }) => {
    await runCommand(
      opts.json,
      () => closeIssue(findProjectRoot(), id, opts.resolution, opts.actor),
      (closed) => process.stdout.write(`closed ${closed.id}: ${closed.resolution ?? ""}\n`),
    );
  });

program
  .command("brief")
  .description(
    "Generate a task-scoped context brief (auto-detects task from git claim if --task is omitted)",
  )
  .option("--task <id>", "task id (auto-detected from current git branch claim if omitted)")
  .option("--budget <budget>", "small|medium|large|full (defaults to project config)")
  .option("--json", "output JSON")
  .action((opts: { task?: string; budget?: string; json?: boolean }) => {
    const root = findProjectRoot();
    const budget = parseBriefBudget(opts.budget ?? configuredBriefBudget(root));
    if (!budget.ok || !budget.data) {
      emitResult(budget as CommandResult<unknown>, opts.json, () => {});
      return;
    }

    if (opts.task) {
      try {
        const result = buildBriefResult(root, opts.task, budget.data);
        emitResult(result, opts.json, () => {
          if (result.data) process.stdout.write(renderBrief(result.data));
        });
      } catch (e) {
        const code =
          e instanceof RecordError || e instanceof MutationError ? e.code : "no_such_task";
        const res = toResult(null, [
          diag(code as never, { message: (e as Error).message, details: { task: opts.task } }),
        ]);
        emitResult(res, opts.json, () => {});
      }
      return;
    }

    // auto-detect task from git claim
    const resolved = resolveTaskFromGitClaim(root);
    if (!resolved.ok || !resolved.data) {
      emitResult(resolved as CommandResult<unknown>, opts.json, () => {});
      return;
    }

    try {
      const result = buildBriefResult(root, resolved.data, budget.data);
      emitResult(result, opts.json, () => {
        if (result.data) process.stdout.write(renderBrief(result.data));
      });
    } catch (e) {
      const code = e instanceof RecordError || e instanceof MutationError ? e.code : "no_such_task";
      const res = toResult(null, [
        diag(code as never, { message: (e as Error).message, details: { task: resolved.data } }),
      ]);
      emitResult(res, opts.json, () => {});
    }
  });

program
  .command("validate")
  .description("Validate the ledger (schemas, references, cycles, claims, events)")
  .option("--project", "also validate caller-project paths and generated report freshness")
  .option("--views", "also freshness-check generated task views (implies --project)")
  .option("--json", "output JSON")
  .action((opts: { project?: boolean; views?: boolean; json?: boolean }) => {
    const res = validateLedger(findProjectRoot(), {
      project: opts.project || opts.views,
      projectRoot: process.cwd(),
      views: opts.views,
    });
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
          `reindexed ${c.tasks} tasks, ${c.issues} issues, ${c.claims_total} claims (${c.claims_active} active), ${c.messages} messages\n`,
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

program
  .command("sync")
  .description("Validate, reindex, regenerate reports, and verify project freshness")
  .option("--views", "also regenerate and validate views/tasks/*.md")
  .option("--json", "output JSON")
  .action(async (opts: { views?: boolean; json?: boolean }) => {
    const res = await syncLedger(findProjectRoot(), {
      projectRoot: process.cwd(),
      views: opts.views,
    });
    emitResult(res, opts.json, () => {
      const data = res.data;
      if (!data) return;
      process.stdout.write(
        `synced ${data.index.tasks} tasks, ${data.index.issues} issues, ${data.index.claims_total} claims (${data.index.claims_active} active), ${data.index.messages} messages\n`,
      );
      for (const file of data.written) process.stdout.write(`generated ${file}\n`);
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
  .option("--json", "output JSON")
  .action(
    async (opts: {
      thread: string;
      from: string;
      to?: string;
      kind: string;
      body: string;
      inReplyTo?: string;
      json?: boolean;
    }) => {
      await runMutation(opts.json, async () => {
        const m = await postMessage(findProjectRoot(), {
          thread: opts.thread,
          from: opts.from,
          to: opts.to ?? null,
          kind: opts.kind as never,
          body: opts.body,
          inReplyTo: opts.inReplyTo ?? null,
        });
        return `posted ${m.id}`;
      });
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

function renderIssue(issue: IssueRecord): string {
  const lines = [issue.id, `  title:        ${issue.title}`, `  status:       ${issue.status}`];
  if (issue.severity) lines.push(`  severity:     ${issue.severity}`);
  if (issue.type) lines.push(`  type:         ${issue.type}`);
  if (issue.priority !== undefined) lines.push(`  priority:     ${issue.priority}`);
  if (issue.task) lines.push(`  task:         ${issue.task}`);
  if (issue.scope) lines.push(`  scope:        ${issue.scope}`);
  for (const [label, value] of [
    ["description", issue.description],
    ["evidence", issue.evidence],
    ["expected", issue.expected],
    ["actual", issue.actual],
    ["resolution", issue.resolution],
    ["notes", issue.notes],
    ["source", issue.source],
  ] as const) {
    if (value !== undefined) {
      lines.push(
        "",
        `${label}:`,
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      );
    }
  }
  if (issue.acceptance?.length) {
    lines.push("", "acceptance:", ...issue.acceptance.map((item) => `  - ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

function parsePriority(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MutationError("priority must be a non-negative integer", "schema_invalid");
  }
  return parsed;
}

function parseJsonValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new MutationError("source must be valid JSON", "invalid_json");
  }
}

function requirePatch(patch: object, kind: "task" | "issue"): void {
  if (Object.keys(patch).length === 0) {
    throw new MutationError(`no ${kind} fields were provided to update`, "schema_invalid");
  }
}

function diagnosticFor(error: unknown) {
  if (error instanceof MutationError) {
    return diag(error.code as never, { message: error.message });
  }
  if (error instanceof RecordError || error instanceof LedgerResolutionError) {
    return diag(error.code as never);
  }
  if (error instanceof ZodError) {
    const message = error.issues[0]?.message ?? "Invalid command input.";
    return diag("schema_invalid", { message: `Invalid command input: ${message}` });
  }
  return diag("unexpected_error");
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

async function runCommand<T>(
  json: boolean | undefined,
  fn: () => Promise<T>,
  renderText: (data: T) => void,
): Promise<void> {
  try {
    const data = await fn();
    emitResult(okResult(data), json, () => renderText(data));
  } catch (error) {
    emitResult(toResult(null, [diagnosticFor(error)]), json, () => {});
  }
}

/** Run a mutation, emitting a CommandResult. MutationError/RecordError map to
 * their code; anything else to unexpected_error. */
async function runMutation(json: boolean | undefined, fn: () => Promise<string>): Promise<void> {
  await runCommand(
    json,
    async () => ({ message: await fn() }),
    ({ message }) => process.stdout.write(`${message}\n`),
  );
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

const gh = program.command("gh").description("GitHub Issues integration");

gh.command("import")
  .description("Import issues from a GitHub repository into the ledger")
  .requiredOption("--repo <repo>", "repository (owner/name)")
  .option("--json", "output JSON")
  .option("--force", "overwrite existing records")
  .action(async (opts: { repo: string; json?: boolean; force?: boolean }) => {
    const root = findProjectRoot();
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!token) {
      const result = toResult(null, [diag("no_github_token" as never)]);
      emitResult(result, opts.json, () => {});
      return;
    }
    const { importGitHubIssues } = await import("../core/gh.ts");
    const result = await importGitHubIssues(root, opts.repo, token);
    emitResult(result, opts.json, () => {
      const d = result.data;
      if (d) {
        process.stdout.write(`Imported ${d.imported} issues: ${d.ids.join(", ")}\n`);
      }
    });
  });

gh.command("export")
  .description("Export ledger issues to a GitHub repository")
  .requiredOption("--repo <repo>", "repository (owner/name)")
  .option("--json", "output JSON")
  .action(async (opts: { repo: string; json?: boolean }) => {
    const root = findProjectRoot();
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!token) {
      const result = toResult(null, [diag("no_github_token" as never)]);
      emitResult(result, opts.json, () => {});
      return;
    }
    const { exportGitHubIssues } = await import("../core/gh.ts");
    const result = await exportGitHubIssues(root, opts.repo, token);
    emitResult(result, opts.json, () => {
      const d = result.data;
      if (d) {
        process.stdout.write(`Exported ${d.exported} issues: ${d.ids.join(", ")}\n`);
      }
    });
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
      const vDir = join(root, "src", "dashboard", "client");
      const _viteProc = Bun.spawn(
        ["bun", "x", "vite", "--port", String(vitePort), "--strictPort"],
        {
          cwd: vDir,
          stdio: ["ignore", "inherit", "inherit"],
        },
      );

      app.use("*", async (c, next) => {
        if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/graphify-out/"))
          return next();
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
    err instanceof RecordError ||
    err instanceof MutationError ||
    err instanceof LedgerResolutionError
      ? err.code
      : "unexpected_error";
  const spec = code in CODES ? CODES[code as keyof typeof CODES] : undefined;
  process.stderr.write(`error [${code}]: ${(err as Error).message}\n`);
  if (spec?.hint) process.stderr.write(`  hint: ${spec.hint}\n`);
  process.exit(1);
}
