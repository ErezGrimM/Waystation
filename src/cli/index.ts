#!/usr/bin/env bun
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
import { loadTaskById, loadTasks, RecordError } from "../core/records.ts";
import { repairEventsJsonl } from "../core/repair.ts";
import { CODES, type CommandResult, diag, okResult, toResult } from "../core/result.ts";
import type { IssueRecord, TaskStatus } from "../core/schema.ts";
import { LockError, loadIssues, withLedgerLock } from "../core/store.ts";
import { syncLedger } from "../core/sync.ts";
import { auditPromotableTasks, nextTask, readyTasks } from "../core/tasks.ts";
import { validateLedger } from "../core/validate.ts";
import { backendWarnings } from "../index/ledgerIndex.ts";
import { buildTaskIndex, readyFromIndex } from "../index/taskIndex.ts";
import { generateHelp, generateVersion, parseArgv } from "./parser.ts";
import type { CommandContext } from "./spec.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  if (error instanceof LockError) {
    return diag(error.code as never);
  }
  if (error instanceof ZodError) {
    const message = error.issues[0]?.message ?? "Invalid command input.";
    return diag("schema_invalid", { message: `Invalid command input: ${message}` });
  }
  return diag("unexpected_error");
}

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

async function runMutation(json: boolean | undefined, fn: () => Promise<string>): Promise<void> {
  await runCommand(
    json,
    async () => ({ message: await fn() }),
    ({ message }) => process.stdout.write(`${message}\n`),
  );
}

// ─── Render helpers ──────────────────────────────────────────────────────────

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

// ─── Command dispatch ────────────────────────────────────────────────────────

function arg(ctx: CommandContext, index: number): string {
  const val = ctx.args[index];
  if (val === undefined) {
    throw new MutationError(`missing argument at position ${index}`, "schema_invalid");
  }
  return val;
}

async function dispatch(ctx: CommandContext, commandPath: string[]): Promise<void> {
  const [command, subcommand] = commandPath;

  // Global --version
  if (!command && ctx.raw.includes("--version")) {
    process.stdout.write(`${generateVersion()}\n`);
    return;
  }

  // Global --help
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(generateHelp(null, null));
    return;
  }

  // init
  if (command === "init") {
    const res = await initLedger(process.cwd(), {
      project: ctx.opts.project as string | undefined,
      force: ctx.opts.force as boolean | undefined,
    });
    emitResult(res, ctx.json, () => {
      const r = res.data;
      if (r?.created) process.stdout.write(`initialized ${r.root} (project: ${r.project})\n`);
      else process.stdout.write("already initialized (use --force to reinitialize)\n");
    });
    return;
  }

  // task commands
  if (command === "task") {
    if (!subcommand) {
      process.stdout.write(
        generateHelp(
          commandPath.length === 1
            ? null
            : {
                name: "task",
                description: "Task commands",
                options: [],
                arguments: [],
                subcommands: [],
              },
          null,
        ),
      );
      return;
    }
    if (subcommand === "next") {
      const tasks = loadTasks();
      const line = (t: { id: string; title: string; priority: number } | null) =>
        process.stdout.write(t ? `${t.id}  [p${t.priority}]  ${t.title}\n` : "No ready tasks.\n");
      if (ctx.opts.fromIndex) {
        const root = findProjectRoot();
        const db = await withLedgerLock(root, () => buildTaskIndex(ledgerPaths(root).index, tasks));
        const ready = readyFromIndex(db);
        const warnings = backendWarnings(db.backend);
        db.close();
        const chosen = ready[0] ?? null;
        emitResult(okResult(chosen, warnings), ctx.json, () => line(chosen));
        return;
      }
      const chosen = nextTask(tasks);
      emitResult(okResult(chosen), ctx.json, () => line(chosen));
      return;
    }
    if (subcommand === "ready") {
      const ready = readyTasks(loadTasks());
      emitResult(okResult(ready), ctx.json, () => {
        if (ready.length === 0) {
          process.stdout.write("No ready tasks.\n");
          return;
        }
        for (const t of ready) process.stdout.write(`${t.id}  [p${t.priority}]  ${t.title}\n`);
      });
      return;
    }
    if (subcommand === "list") {
      let tasks = loadTasks();
      if (ctx.opts.status) tasks = tasks.filter((t) => t.status === ctx.opts.status);
      tasks.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      emitResult(okResult(tasks), ctx.json, () => {
        if (tasks.length === 0) {
          process.stdout.write("No tasks.\n");
          return;
        }
        for (const t of tasks)
          process.stdout.write(`${t.id}  [p${t.priority}]  ${t.status.padEnd(11)}  ${t.title}\n`);
      });
      return;
    }
    if (subcommand === "audit") {
      const tasks = auditPromotableTasks(loadTasks());
      emitResult(okResult(tasks), ctx.json, () => {
        if (tasks.length === 0) {
          process.stdout.write("No dependency-satisfied todo tasks.\n");
          return;
        }
        process.stdout.write(
          "dependency-satisfied todo tasks (promote to ready intentionally, never automatically):\n",
        );
        for (const t of tasks) process.stdout.write(`${t.id}  [p${t.priority}]  ${t.title}\n`);
      });
      return;
    }
    if (subcommand === "show") {
      const id = arg(ctx, 0);
      const found = loadTaskById(id);
      const res = found
        ? okResult(found)
        : toResult(null, [
            diag("no_such_task", { message: `no such task: ${id}`, details: { id } }),
          ]);
      emitResult(res, ctx.json, () => {
        if (!found) return;
        process.stdout.write(`${found.id}\n`);
        process.stdout.write(`  title:        ${found.title}\n`);
        process.stdout.write(`  status:       ${found.status}\n`);
        process.stdout.write(`  priority:     ${found.priority}\n`);
        if (found.scope) process.stdout.write(`  scope:        ${found.scope}\n`);
        if (found.dependencies.length)
          process.stdout.write(`  dependencies: ${found.dependencies.join(", ")}\n`);
        if (found.commits.length)
          process.stdout.write(`  commits:      ${found.commits.join(", ")}\n`);
        if (found.description) process.stdout.write(`\n${found.description.trimEnd()}\n`);
      });
      return;
    }
    if (subcommand === "create") {
      const id = arg(ctx, 0);
      await runCommand(
        ctx.json,
        () =>
          createTask(
            findProjectRoot(),
            {
              id,
              title: ctx.opts.title as string,
              status: ctx.opts.status as TaskStatus,
              priority: parsePriority(ctx.opts.priority as string) ?? 3,
              scope: (ctx.opts.scope as string) ?? null,
              path_hints: (ctx.opts.pathHint as string[]) ?? [],
              prompts: (ctx.opts.prompt as string[]) ?? [],
              dependencies: (ctx.opts.dependsOn as string[]) ?? [],
              description: ctx.opts.description as string | undefined,
              acceptance: (ctx.opts.acceptance as string[]) ?? [],
              notes: ctx.opts.notes as string | undefined,
            },
            ctx.opts.actor as string,
          ),
        (created) => process.stdout.write(`created ${created.id} (${created.status})\n`),
      );
      return;
    }
    if (subcommand === "update") {
      const id = arg(ctx, 0);
      await runCommand(
        ctx.json,
        () => {
          const patch: TaskPatch = {};
          if (ctx.opts.title !== undefined) patch.title = ctx.opts.title as string;
          if (ctx.opts.priority !== undefined) {
            const p = parsePriority(ctx.opts.priority as string);
            if (p !== undefined) patch.priority = p;
          }
          if (ctx.opts.scope !== undefined) patch.scope = ctx.opts.scope as string;
          if (ctx.opts.pathHint !== undefined || ctx.opts.clearPathHints)
            patch.path_hints = ctx.opts.clearPathHints ? [] : (ctx.opts.pathHint as string[]);
          if (ctx.opts.prompt !== undefined || ctx.opts.clearPrompts)
            patch.prompts = ctx.opts.clearPrompts ? [] : (ctx.opts.prompt as string[]);
          if (ctx.opts.dependsOn !== undefined || ctx.opts.clearDependencies)
            patch.dependencies = ctx.opts.clearDependencies ? [] : (ctx.opts.dependsOn as string[]);
          if (ctx.opts.description !== undefined)
            patch.description = ctx.opts.description as string;
          if (ctx.opts.acceptance !== undefined || ctx.opts.clearAcceptance)
            patch.acceptance = ctx.opts.clearAcceptance ? [] : (ctx.opts.acceptance as string[]);
          if (ctx.opts.notes !== undefined) patch.notes = ctx.opts.notes as string;
          requirePatch(patch, "task");
          return updateTask(findProjectRoot(), id, patch, ctx.opts.actor as string);
        },
        (updated) => process.stdout.write(`updated ${updated.id}\n`),
      );
      return;
    }
    if (subcommand === "set-status") {
      const id = arg(ctx, 0);
      const status = arg(ctx, 1);
      await runCommand(
        ctx.json,
        () => setTaskStatus(findProjectRoot(), id, status as TaskStatus, ctx.opts.actor as string),
        (updated) => process.stdout.write(`${updated.id} status: ${updated.status}\n`),
      );
      return;
    }
    if (subcommand === "reopen") {
      const id = arg(ctx, 0);
      const status = ctx.opts.status as string;
      if (status !== "todo" && status !== "ready") {
        emitResult(
          toResult(null, [
            diag("schema_invalid", { message: "reopen status must be todo or ready" }),
          ]),
          ctx.json,
          () => {},
        );
        return;
      }
      await runCommand(
        ctx.json,
        () =>
          reopenTask(findProjectRoot(), id, status as "todo" | "ready", ctx.opts.actor as string),
        (updated) => process.stdout.write(`reopened ${updated.id} as ${updated.status}\n`),
      );
      return;
    }
    if (subcommand === "claim") {
      const id = arg(ctx, 0);
      await runMutation(ctx.json, async () => {
        const claim = await claimTask(findProjectRoot(), id, ctx.opts.agent as string, new Date(), {
          branch: ctx.opts.branch as string | undefined,
          worktree: ctx.opts.worktree as string | undefined,
          caller: process.cwd(),
        });
        return `claimed ${id} as ${claim.id}`;
      });
      return;
    }
    if (subcommand === "release") {
      const id = arg(ctx, 0);
      await runMutation(ctx.json, async () => {
        await releaseTask(findProjectRoot(), id, ctx.opts.agent as string);
        return `released ${id}`;
      });
      return;
    }
    if (subcommand === "finish") {
      const id = arg(ctx, 0);
      await runMutation(ctx.json, async () => {
        await finishTask(findProjectRoot(), id, ctx.opts.agent as string, new Date(), {
          commits: (ctx.opts.commit as string[]) ?? [],
          commitHead: ctx.opts.commitHead as boolean | undefined,
        });
        return `finished ${id}`;
      });
      return;
    }
  }

  // issue commands
  if (command === "issue") {
    if (!subcommand) {
      process.stdout.write(generateHelp(null, null));
      return;
    }
    if (subcommand === "list") {
      await runCommand(
        ctx.json,
        async () => {
          let issues = loadIssues();
          if (ctx.opts.status) issues = issues.filter((i) => i.status === ctx.opts.status);
          return issues.sort((a, b) => a.id.localeCompare(b.id));
        },
        (issues) => {
          if (issues.length === 0) {
            process.stdout.write("No issues.\n");
            return;
          }
          for (const item of issues)
            process.stdout.write(`${item.id}  ${item.status.padEnd(11)}  ${item.title}\n`);
        },
      );
      return;
    }
    if (subcommand === "show") {
      const id = arg(ctx, 0);
      await runCommand(
        ctx.json,
        async () => {
          const found = loadIssues().find((i) => i.id === id);
          if (!found) throw new MutationError(`no such issue: ${id}`, "not_found");
          return found;
        },
        (found) => process.stdout.write(renderIssue(found)),
      );
      return;
    }
    if (subcommand === "create") {
      await runCommand(
        ctx.json,
        () => {
          const input: CreateIssueInput = {
            id: ctx.opts.id as string | undefined,
            title: ctx.opts.title as string,
            status: ctx.opts.status as string | undefined,
            severity: ctx.opts.severity as string | undefined,
            type: ctx.opts.type as string | undefined,
            priority: parsePriority(ctx.opts.priority as string),
            task: ctx.opts.task as string | undefined,
            scope: ctx.opts.scope as string | undefined,
            description: ctx.opts.description as string | undefined,
            evidence: ctx.opts.evidence as string | undefined,
            expected: ctx.opts.expected as string | undefined,
            actual: ctx.opts.actual as string | undefined,
            acceptance: (ctx.opts.acceptance as string[]) ?? undefined,
            resolution: ctx.opts.resolution as string | undefined,
            notes: ctx.opts.notes as string | undefined,
            source: parseJsonValue(ctx.opts.source as string),
          };
          return createIssue(findProjectRoot(), input);
        },
        (created) => process.stdout.write(`created ${created.id} (${created.status})\n`),
      );
      return;
    }
    if (subcommand === "update") {
      const id = arg(ctx, 0);
      await runCommand(
        ctx.json,
        () => {
          const patch: UpdateIssueInput = {};
          if (ctx.opts.title !== undefined) patch.title = ctx.opts.title as string;
          if (ctx.opts.status !== undefined) patch.status = ctx.opts.status as string;
          if (ctx.opts.severity !== undefined) patch.severity = ctx.opts.severity as string;
          if (ctx.opts.type !== undefined) patch.type = ctx.opts.type as string;
          if (ctx.opts.priority !== undefined) {
            const p = parsePriority(ctx.opts.priority as string);
            if (p !== undefined) patch.priority = p;
          }
          if (ctx.opts.task !== undefined) patch.task = ctx.opts.task as string;
          if (ctx.opts.scope !== undefined) patch.scope = ctx.opts.scope as string;
          if (ctx.opts.description !== undefined)
            patch.description = ctx.opts.description as string;
          if (ctx.opts.evidence !== undefined) patch.evidence = ctx.opts.evidence as string;
          if (ctx.opts.expected !== undefined) patch.expected = ctx.opts.expected as string;
          if (ctx.opts.actual !== undefined) patch.actual = ctx.opts.actual as string;
          if (ctx.opts.acceptance !== undefined || ctx.opts.clearAcceptance)
            patch.acceptance = ctx.opts.clearAcceptance ? [] : (ctx.opts.acceptance as string[]);
          if (ctx.opts.resolution !== undefined) patch.resolution = ctx.opts.resolution as string;
          if (ctx.opts.notes !== undefined) patch.notes = ctx.opts.notes as string;
          if (ctx.opts.source !== undefined)
            patch.source = parseJsonValue(ctx.opts.source as string);
          requirePatch(patch, "issue");
          return updateIssue(findProjectRoot(), id, patch, ctx.opts.actor as string);
        },
        (updated) => process.stdout.write(`updated ${updated.id}\n`),
      );
      return;
    }
    if (subcommand === "close") {
      const id = arg(ctx, 0);
      await runCommand(
        ctx.json,
        () =>
          closeIssue(
            findProjectRoot(),
            id,
            ctx.opts.resolution as string,
            ctx.opts.actor as string,
          ),
        (closed) => process.stdout.write(`closed ${closed.id}: ${closed.resolution ?? ""}\n`),
      );
      return;
    }
  }

  // brief
  if (command === "brief") {
    const root = findProjectRoot();
    const budget = parseBriefBudget((ctx.opts.budget as string) ?? configuredBriefBudget(root));
    if (!budget.ok || !budget.data) {
      emitResult(budget as CommandResult<unknown>, ctx.json, () => {});
      return;
    }
    if (ctx.opts.task) {
      try {
        const result = buildBriefResult(root, ctx.opts.task as string, budget.data);
        emitResult(result, ctx.json, () => {
          if (result.data) process.stdout.write(renderBrief(result.data));
        });
      } catch (e) {
        const code =
          e instanceof RecordError || e instanceof MutationError ? e.code : "no_such_task";
        emitResult(
          toResult(null, [
            diag(code as never, {
              message: (e as Error).message,
              details: { task: ctx.opts.task },
            }),
          ]),
          ctx.json,
          () => {},
        );
      }
      return;
    }
    const resolved = resolveTaskFromGitClaim(root);
    if (!resolved.ok || !resolved.data) {
      emitResult(resolved as CommandResult<unknown>, ctx.json, () => {});
      return;
    }
    try {
      const result = buildBriefResult(root, resolved.data, budget.data);
      emitResult(result, ctx.json, () => {
        if (result.data) process.stdout.write(renderBrief(result.data));
      });
    } catch (e) {
      const code = e instanceof RecordError || e instanceof MutationError ? e.code : "no_such_task";
      emitResult(
        toResult(null, [
          diag(code as never, { message: (e as Error).message, details: { task: resolved.data } }),
        ]),
        ctx.json,
        () => {},
      );
    }
    return;
  }

  // validate
  if (command === "validate") {
    const res = validateLedger(findProjectRoot(), {
      project: (ctx.opts.project as boolean) || (ctx.opts.views as boolean),
      projectRoot: process.cwd(),
      views: ctx.opts.views as boolean,
    });
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.ok && res.warnings.length === 0) {
      process.stdout.write("ok: no problems found.\n");
    } else {
      for (const d of res.errors) process.stdout.write(`ERROR [${d.code}] ${d.message}\n`);
      for (const d of res.warnings) process.stdout.write(`WARNING [${d.code}] ${d.message}\n`);
      process.stdout.write(`\n${res.errors.length} error(s), ${res.warnings.length} warning(s)\n`);
    }
    if (!res.ok) process.exit(1);
    return;
  }

  // reindex
  if (command === "reindex") {
    const root = findProjectRoot();
    const res = await withLedgerLock(root, () => reindex(root));
    emitResult(res, ctx.json, () => {
      const c = res.data;
      if (c)
        process.stdout.write(
          `reindexed ${c.tasks} tasks, ${c.issues} issues, ${c.claims_total} claims (${c.claims_active} active), ${c.messages} messages\n`,
        );
    });
    return;
  }

  // repair
  if (command === "repair") {
    const res = await repairEventsJsonl(findProjectRoot());
    emitResult(res, ctx.json, () => {
      const r = res.data;
      if (!r) return;
      if (!r.rewritten) {
        process.stdout.write("events.jsonl is clean; nothing to repair.\n");
        return;
      }
      const details = [`${r.finalLines} event line(s)`];
      if (r.fixedLines > 0) details.unshift(`split ${r.fixedLines} line(s)`);
      if (r.newlineFixed) details.push("added trailing newline");
      process.stdout.write(`repaired events.jsonl: ${details.join(", ")}\n`);
    });
    return;
  }

  // report
  if (command === "report") {
    const root = findProjectRoot();
    const written = await withLedgerLock(root, () => {
      const files = generateReports(root);
      if (ctx.opts.views) files.push(`views/tasks/ (${generateTaskViews(root)} files)`);
      return files;
    });
    emitResult(okResult({ written }), ctx.json, () => {
      for (const f of written) process.stdout.write(`generated ${f}\n`);
    });
    return;
  }

  // sync
  if (command === "sync") {
    const res = await syncLedger(findProjectRoot(), {
      projectRoot: process.cwd(),
      views: ctx.opts.views as boolean,
    });
    emitResult(res, ctx.json, () => {
      const data = res.data;
      if (!data) return;
      process.stdout.write(
        `synced ${data.index.tasks} tasks, ${data.index.issues} issues, ${data.index.claims_total} claims (${data.index.claims_active} active), ${data.index.messages} messages\n`,
      );
      for (const file of data.written) process.stdout.write(`generated ${file}\n`);
    });
    return;
  }

  // handoff
  if (command === "handoff") {
    if (!subcommand) {
      process.stdout.write(generateHelp(null, null));
      return;
    }
    if (subcommand === "create") {
      await runMutation(ctx.json, async () => {
        const h = await createHandoff(findProjectRoot(), {
          task: ctx.opts.task as string,
          from: ctx.opts.from as string,
          to: (ctx.opts.to as string) ?? null,
          summary: ctx.opts.summary as string | undefined,
        });
        return `created ${h.id}`;
      });
      return;
    }
    if (subcommand === "show") {
      const id = arg(ctx, 0);
      const h = getHandoff(findProjectRoot(), id) ?? null;
      const res = h
        ? okResult(h)
        : toResult(null, [
            diag("not_found", { message: `no such handoff: ${id}`, details: { id } }),
          ]);
      emitResult(res, ctx.json, () => {
        if (!h) return;
        process.stdout.write(`${h.id}\n`);
        process.stdout.write(`  task:    ${h.task}\n`);
        process.stdout.write(
          `  from:    ${h.from_agent}${h.to_agent ? ` -> ${h.to_agent}` : ""}\n`,
        );
        if (h.summary) process.stdout.write(`\n${h.summary.trimEnd()}\n`);
        if (h.next_steps.length)
          process.stdout.write(
            `\nnext steps:\n${h.next_steps.map((s) => `  - ${s}`).join("\n")}\n`,
          );
      });
      return;
    }
  }

  // prompt
  if (command === "prompt") {
    if (!subcommand) {
      process.stdout.write(generateHelp(null, null));
      return;
    }
    if (subcommand === "list") {
      const prompts = loadPrompts(findProjectRoot());
      emitResult(okResult(prompts), ctx.json, () => {
        if (prompts.length === 0) {
          process.stdout.write("No prompts.\n");
          return;
        }
        for (const p of prompts) process.stdout.write(`${p.id}  [${p.status}]  ${p.title}\n`);
      });
      return;
    }
    if (subcommand === "show") {
      const id = arg(ctx, 0);
      const p = getPrompt(findProjectRoot(), id) ?? null;
      const res = p
        ? okResult(p)
        : toResult(null, [
            diag("not_found", { message: `no such prompt: ${id}`, details: { id } }),
          ]);
      emitResult(res, ctx.json, () => {
        if (p) process.stdout.write(renderPrompt(p, {}));
      });
      return;
    }
    if (subcommand === "render") {
      const root = findProjectRoot();
      const task = loadTasks(root).find((t) => t.id === ctx.opts.task);
      if (!task) {
        emitResult(
          toResult(null, [
            diag("no_such_task", {
              message: `no such task: ${ctx.opts.task}`,
              details: { id: ctx.opts.task },
            }),
          ]),
          ctx.json,
          () => {},
        );
        return;
      }
      const c = {
        agent: ctx.opts.agent as string,
        role: ctx.opts.role as string | undefined,
        task: task.id,
        scope: task.scope ?? undefined,
      };
      const vars = {
        task_id: task.id,
        agent: ctx.opts.agent as string,
        scope: task.scope ?? undefined,
      };
      const selected = selectPrompts(root, c);
      const rendered = selected.length
        ? selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n")
        : "No applicable prompts.\n";
      emitResult(okResult({ prompts: selected.map((p) => p.id), rendered }), ctx.json, () =>
        process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`),
      );
      return;
    }
  }

  // message
  if (command === "message") {
    if (!subcommand) {
      process.stdout.write(generateHelp(null, null));
      return;
    }
    if (subcommand === "post") {
      await runMutation(ctx.json, async () => {
        const m = await postMessage(findProjectRoot(), {
          thread: ctx.opts.thread as string,
          from: ctx.opts.from as string,
          to: (ctx.opts.to as string) ?? null,
          kind: ctx.opts.kind as never,
          body: ctx.opts.body as string,
          inReplyTo: (ctx.opts.inReplyTo as string) ?? null,
        });
        return `posted ${m.id}`;
      });
      return;
    }
    if (subcommand === "list") {
      const msgs = threadMessages(findProjectRoot(), ctx.opts.thread as string);
      if (ctx.json) {
        process.stdout.write(`${JSON.stringify(msgs, null, 2)}\n`);
        return;
      }
      if (msgs.length === 0) {
        process.stdout.write("No messages.\n");
        return;
      }
      for (const m of msgs) process.stdout.write(renderMessage(m));
      return;
    }
  }

  // inbox
  if (command === "inbox") {
    const msgs = inbox(
      findProjectRoot(),
      ctx.opts.agent as string,
      ctx.opts.since as string | undefined,
    );
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(msgs, null, 2)}\n`);
      return;
    }
    if (msgs.length === 0) {
      process.stdout.write("Inbox empty.\n");
      return;
    }
    for (const m of msgs) process.stdout.write(renderMessage(m));
    return;
  }

  // git
  if (command === "git") {
    if (subcommand === "status") {
      const res = getGitState(findProjectRoot());
      emitResult(res, ctx.json, () => {
        const state = res.data;
        if (!state) return;
        process.stdout.write(renderGitState(state));
      });
      return;
    }
  }

  // mcp
  if (command === "mcp") {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { buildServer } = await import("../mcp/server.ts");
    const root = findProjectRoot();
    const server = buildServer(root);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // gh
  if (command === "gh") {
    if (!subcommand) {
      process.stdout.write(generateHelp(null, null));
      return;
    }
    if (subcommand === "import") {
      const root = findProjectRoot();
      const token = process.env.GITHUB_TOKEN ?? "";
      if (!token) {
        emitResult(toResult(null, [diag("no_github_token" as never)]), ctx.json, () => {});
        return;
      }
      const { importGitHubIssues } = await import("../core/gh.ts");
      const result = await importGitHubIssues(
        root,
        ctx.opts.repo as string,
        token,
        (ctx.opts.force as boolean) ?? false,
      );
      emitResult(result, ctx.json, () => {
        const d = result.data;
        if (d) process.stdout.write(`Imported ${d.imported} issues: ${d.ids.join(", ")}\n`);
      });
      return;
    }
    if (subcommand === "export") {
      const root = findProjectRoot();
      const token = process.env.GITHUB_TOKEN ?? "";
      if (!token) {
        emitResult(toResult(null, [diag("no_github_token" as never)]), ctx.json, () => {});
        return;
      }
      const { exportGitHubIssues } = await import("../core/gh.ts");
      const result = await exportGitHubIssues(root, ctx.opts.repo as string, token);
      emitResult(result, ctx.json, () => {
        const d = result.data;
        if (d) process.stdout.write(`Exported ${d.exported} issues: ${d.ids.join(", ")}\n`);
      });
      return;
    }
  }

  // dashboard
  if (command === "dashboard") {
    const { createApp, dashboardClientDir, productionDashboardDir } = await import(
      "../dashboard/server.ts"
    );
    const root = findProjectRoot();
    const app = createApp(root, ctx.opts.dev ? undefined : productionDashboardDir());
    const port = Number(ctx.opts.port);
    if (ctx.opts.dev) {
      const vitePort = 5173;
      const vDir = dashboardClientDir();
      const bunExecutable = Bun.isStandaloneExecutable ? "bun" : process.execPath;
      const _viteProc = Bun.spawn(
        [bunExecutable, "x", "vite", "--port", String(vitePort), "--strictPort"],
        { cwd: vDir, stdio: ["ignore", "inherit", "inherit"] },
      );
      app.use("*", async (c, next) => {
        if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/graphify-out/"))
          return next();
        const target = `http://127.0.0.1:${vitePort}${c.req.path}`;
        const res = await fetch(target);
        return new Response(res.body, { status: res.status, headers: res.headers });
      });
      process.stderr.write(`Vite dev server on http://127.0.0.1:${vitePort}\n`);
      process.stderr.write(`Dashboard on http://127.0.0.1:${port}\n`);
    }
    process.stderr.write(`Waystation dashboard listening on http://127.0.0.1:${port}\n`);
    Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
    return;
  }

  // Unknown command
  process.stderr.write(`error [unexpected_error]: unknown command: ${command}\n`);
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Check for empty variadic options before dispatch
  const listOptionNames = ["--depends-on", "--acceptance", "--path-hint", "--prompt", "--commit"];
  const taskIssueIdx = rawArgs.findIndex((a) => a === "task" || a === "issue");
  if (taskIssueIdx >= 0 && !rawArgs.includes("--help") && !rawArgs.includes("-h")) {
    for (let i = taskIssueIdx + 1; i < rawArgs.length; i++) {
      const arg = rawArgs[i] ?? "";
      if (listOptionNames.includes(arg)) {
        const next = rawArgs[i + 1];
        if (next === undefined || next.startsWith("-")) {
          emitResult(
            toResult(null, [
              diag("cli_option_value_required", {
                message: `Option ${arg} requires at least one value.`,
                details: { option: arg },
              }),
            ]),
            rawArgs.includes("--json"),
            () => {},
          );
          return;
        }
      }
    }
  }

  const result = parseArgv(rawArgs);

  if (result.error) {
    process.stderr.write(`error [unexpected_error]: ${result.error}\n`);
    process.exit(1);
  }

  if (result.versionRequested) {
    process.stdout.write(`${generateVersion()}\n`);
    return;
  }

  if (result.helpRequested) {
    const path = result.command ? [result.command.name] : [];
    if (result.parent) path.unshift(result.parent.name);
    process.stdout.write(generateHelp(result.command, result.parent));
    return;
  }

  // Set root env if provided
  if (result.ctx.root) {
    process.env.WAYSTATION_ROOT = result.ctx.root;
  }

  // Build command path from parsed result
  const commandPath: string[] = [];
  if (result.parent) commandPath.push(result.parent.name);
  if (result.command) commandPath.push(result.command.name);

  await dispatch(result.ctx, commandPath);
}

main().catch((err) => {
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
});
