import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBrief, parseBriefBudget } from "../core/brief.ts";
import { buildGitContext } from "../core/gitContext.ts";
import { createHandoff } from "../core/handoff.ts";
import { closeIssue, createIssue, updateIssue } from "../core/issue.ts";
import { inbox, postMessage } from "../core/messages.ts";
import {
  addTaskCommits,
  claimTask,
  createTask,
  finishTask,
  MutationError,
  releaseTask,
  reopenTask,
  setTaskStatus,
  updateTask,
} from "../core/mutate.ts";
import { resolveLedgerRoot } from "../core/paths.ts";
import { loadPrompts, renderPrompt, selectPrompts } from "../core/prompt.ts";
import { loadTasks, RecordError } from "../core/records.ts";
import { type CommandResult, type Diagnostic, diag, okResult, toResult } from "../core/result.ts";
import { RecordId, TaskRecord as TaskSchema, TaskStatus } from "../core/schema.ts";
import { loadIssues } from "../core/store.ts";
import { nextTask, readyTasks } from "../core/tasks.ts";
import { validateLedger } from "../core/validate.ts";

function toContent(result: CommandResult): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function catchDiag(e: unknown, fallbackCode: string = "unexpected_error"): Diagnostic {
  if (e instanceof MutationError) {
    return diag(e.code as never, { message: e.message });
  }
  if (e instanceof RecordError) return diag(e.code as never);
  return diag(fallbackCode as never);
}

/** Build an MCP server bound to one validated ledger root. */
export function buildServer(root?: string): McpServer {
  return buildServerAtRoot(resolveLedgerRoot({ explicitRoot: root }));
}

function buildServerAtRoot(root: string): McpServer {
  const server = new McpServer(
    { name: "waystation", version: "0.0.3" },
    { instructions: `Selected Waystation ledger root: ${root}` },
  );

  // ── read tools ──

  server.registerTool(
    "get_status",
    { description: "Task counts by status and ready task list" },
    async () => {
      const tasks = loadTasks(root);
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
      const ready = readyTasks(tasks);
      const readyIds = ready.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        status: t.status,
      }));
      return toContent(
        okResult({ ledgerRoot: root, total: tasks.length, counts, ready: readyIds }),
      );
    },
  );

  server.registerTool(
    "get_next_task",
    { description: "The single highest-priority ready task, or null if none" },
    async () => {
      const task = nextTask(loadTasks(root));
      return toContent(okResult(task));
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "Get a single task by id",
      inputSchema: { id: z.string().describe("task id") },
    },
    async ({ id }) => {
      const task = loadTasks(root).find((t) => t.id === id) ?? null;
      if (!task) {
        return toContent(
          toResult(null, [
            diag("no_such_task", { message: `no such task: ${id}`, details: { id } }),
          ]),
        );
      }
      return toContent(okResult(task));
    },
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get a single issue by id",
      inputSchema: { id: RecordId.describe("issue id") },
    },
    async ({ id }) => {
      try {
        const issue = loadIssues(root).find((item) => item.id === id);
        if (!issue) {
          return toContent(
            toResult(null, [
              diag("not_found", { message: `no such issue: ${id}`, details: { id } }),
            ]),
          );
        }
        return toContent(okResult(issue));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "get_brief",
    {
      description: "Generate a task-scoped context brief",
      inputSchema: {
        task: z.string().describe("task id"),
        budget: z.string().optional().describe("small|medium|large|full (default: medium)"),
      },
    },
    async ({ task, budget }) => {
      try {
        const parsedBudget = parseBriefBudget(budget);
        if (!parsedBudget.ok || !parsedBudget.data) return toContent(parsedBudget);
        const brief = buildBrief(root, task, parsedBudget.data);
        return toContent(okResult(brief));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e, "no_such_task")]));
      }
    },
  );

  server.registerTool(
    "render_prompt",
    {
      description: "Render applicable prompts for a task/agent context",
      inputSchema: {
        task: z.string().describe("task id"),
        agent: z.string().describe("agent name"),
        role: z.string().optional().describe("agent role"),
      },
    },
    async ({ task: taskId, agent, role }) => {
      const loaded = loadTasks(root);
      const task = loaded.find((t) => t.id === taskId);
      if (!task) {
        return toContent(
          toResult(null, [
            diag("no_such_task", { message: `no such task: ${taskId}`, details: { id: taskId } }),
          ]),
        );
      }
      const ctx = { agent, role, task: task.id, scope: task.scope ?? undefined };
      const vars = { task_id: task.id, agent, scope: task.scope ?? undefined };
      const selected = selectPrompts(root, ctx);
      const rendered = selected.length
        ? selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n")
        : "No applicable prompts.\n";
      return toContent(okResult({ prompts: selected.map((p) => p.id), rendered }));
    },
  );

  server.registerTool(
    "list_issues",
    { description: "List all issue records from the ledger" },
    async () => {
      const issues = loadIssues(root);
      return toContent(okResult(issues));
    },
  );

  server.registerTool(
    "get_inbox",
    {
      description: "Show messages addressed to an agent",
      inputSchema: {
        agent: z.string().describe("agent whose inbox to read"),
        since: z.string().optional().describe("ISO timestamp cursor"),
      },
    },
    async ({ agent, since }) => {
      const msgs = inbox(root, agent, since);
      return toContent(okResult(msgs));
    },
  );

  server.registerTool(
    "validate_ledger",
    { description: "Validate the entire ledger (schemas, references, cycles, events)" },
    async () => {
      const result = validateLedger(root);
      return toContent(result);
    },
  );

  server.registerTool(
    "get_git_context",
    { description: "Current git/worktree state, active claim mappings, and overlap warnings" },
    async () => {
      return toContent(buildGitContext(root));
    },
  );

  // ── write tools ──

  server.registerTool(
    "create_task",
    {
      description: "Create a canonical task record",
      inputSchema: {
        id: RecordId.describe("task id"),
        title: TaskSchema.shape.title.describe("task title"),
        status: TaskStatus.optional().describe("initial status (default: todo)"),
        priority: TaskSchema.shape.priority.optional(),
        scope: TaskSchema.shape.scope,
        path_hints: TaskSchema.shape.path_hints.optional(),
        prompts: TaskSchema.shape.prompts.optional(),
        dependencies: TaskSchema.shape.dependencies.optional(),
        description: TaskSchema.shape.description,
        acceptance: TaskSchema.shape.acceptance.optional(),
        notes: TaskSchema.shape.notes,
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ actor, ...input }) => {
      try {
        const task = await createTask(
          root,
          {
            ...input,
            status: input.status ?? "todo",
            priority: input.priority ?? 3,
            path_hints: input.path_hints ?? [],
            prompts: input.prompts ?? [],
            dependencies: input.dependencies ?? [],
            acceptance: input.acceptance ?? [],
          },
          actor ?? "mcp",
        );
        return toContent(okResult(task));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      description: "Update mutable task fields without changing lifecycle status",
      inputSchema: {
        id: RecordId.describe("task id"),
        title: TaskSchema.shape.title.optional(),
        priority: TaskSchema.shape.priority.optional(),
        scope: TaskSchema.shape.scope,
        path_hints: TaskSchema.shape.path_hints.optional(),
        prompts: TaskSchema.shape.prompts.optional(),
        dependencies: TaskSchema.shape.dependencies.optional(),
        description: TaskSchema.shape.description,
        acceptance: TaskSchema.shape.acceptance.optional(),
        notes: TaskSchema.shape.notes,
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ id, actor, ...patch }) => {
      try {
        const task = await updateTask(root, id, patch, actor ?? "mcp");
        return toContent(okResult(task));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "set_task_status",
    {
      description: "Apply a valid non-claim task status transition",
      inputSchema: {
        id: RecordId.describe("task id"),
        status: TaskStatus.describe("target status"),
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ id, status, actor }) => {
      try {
        const task = await setTaskStatus(root, id, status, actor ?? "mcp");
        return toContent(okResult(task));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "reopen_task",
    {
      description: "Reopen a done or wont_do task as todo or ready",
      inputSchema: {
        id: RecordId.describe("task id"),
        status: z.enum(["todo", "ready"]).describe("reopened status"),
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ id, status, actor }) => {
      try {
        const task = await reopenTask(root, id, status, actor ?? "mcp");
        return toContent(okResult(task));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "claim_task",
    {
      description: "Claim a task (creates an active claim, moves task to in_progress)",
      inputSchema: {
        id: z.string().describe("task id"),
        agent: z.string().describe("claiming agent"),
      },
    },
    async ({ id, agent }) => {
      try {
        const claim = await claimTask(root, id, agent);
        return toContent(okResult(claim));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "release_task",
    {
      description: "Release the active claim on a task (moves task back to ready)",
      inputSchema: {
        id: z.string().describe("task id"),
        agent: z.string().describe("releasing agent"),
      },
    },
    async ({ id, agent }) => {
      try {
        await releaseTask(root, id, agent);
        return toContent(okResult({ released: id }));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "finish_task",
    {
      description: "Finish a task (marks it done and completes any active claim)",
      inputSchema: {
        id: z.string().describe("task id"),
        agent: z.string().describe("finishing agent"),
        commits: z.array(z.string()).optional().describe("commit hashes to attach"),
        commitHead: z.boolean().optional().describe("attach current git HEAD"),
      },
    },
    async ({ id, agent, commits, commitHead }) => {
      try {
        await finishTask(root, id, agent, new Date(), {
          commits: commits ?? [],
          commitHead,
        });
        return toContent(okResult({ finished: id }));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "add_task_commit",
    {
      description: "Attach commit reference(s) to a task without changing status",
      inputSchema: {
        id: z.string().describe("task id"),
        commits: z.array(z.string()).describe("commit hashes to attach"),
        agent: z.string().optional().describe("agent adding the reference"),
      },
    },
    async ({ id, commits, agent }) => {
      try {
        const task = await addTaskCommits(root, id, commits, agent ?? "mcp");
        return toContent(okResult(task));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "create_handoff",
    {
      description: "Create a handoff record for a task (baton pass between agents)",
      inputSchema: {
        task: z.string().describe("task id"),
        from: z.string().describe("handing-off agent"),
        to: z.string().optional().describe("receiving agent (omit for next available)"),
        summary: z.string().optional().describe("summary of current state"),
      },
    },
    async ({ task, from, to, summary }) => {
      try {
        const h = await createHandoff(root, {
          task,
          from,
          to: to ?? null,
          summary,
        });
        return toContent(okResult(h));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "post_message",
    {
      description: "Post a message to a thread",
      inputSchema: {
        thread: z.string().describe("task/issue id, or 'project' for the folder-wide channel"),
        from: z.string().describe("author agent"),
        to: z.string().optional().describe("recipient; omit to broadcast to the thread"),
        kind: z.string().optional().describe("update|question|verdict|note (default: update)"),
        body: z.string().describe("message body"),
      },
    },
    async ({ thread, from, to, kind, body }) => {
      try {
        const m = await postMessage(root, {
          thread,
          from,
          to: to ?? null,
          kind: kind as never,
          body,
        });
        return toContent(okResult(m));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "create_issue",
    {
      description: "Create a new issue record in the ledger",
      inputSchema: {
        id: z.string().optional().describe("issue id (auto-generated if omitted)"),
        title: z.string().describe("issue title"),
        status: z.string().optional().describe("status (default: open)"),
        severity: z.string().optional().describe("e.g. low, medium, high, critical"),
        type: z.string().optional().describe("e.g. bug, feature, task, question"),
        priority: z.number().int().optional().describe("numeric priority"),
        task: RecordId.nullable().optional().describe("linked task id"),
        scope: RecordId.nullable().optional().describe("scope id"),
        description: z.string().optional().describe("issue description"),
        evidence: z.string().optional().describe("textual evidence"),
        expected: z.string().optional(),
        actual: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        resolution: z.string().optional(),
        notes: z.string().optional(),
        source: z.unknown().optional().describe("source-system metadata"),
      },
    },
    async (input) => {
      try {
        const issue = await createIssue(root, input);
        return toContent(okResult(issue));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "update_issue",
    {
      description: "Update mutable issue fields while preserving omitted context",
      inputSchema: {
        id: RecordId.describe("issue id"),
        title: z.string().min(1).optional(),
        status: z.string().optional(),
        severity: z.string().optional(),
        type: z.string().optional(),
        priority: z.number().int().optional(),
        task: RecordId.nullable().optional(),
        scope: RecordId.nullable().optional(),
        description: z.string().optional(),
        evidence: z.string().optional(),
        expected: z.string().optional(),
        actual: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        resolution: z.string().optional(),
        notes: z.string().optional(),
        source: z.unknown().optional(),
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ id, actor, ...patch }) => {
      try {
        const issue = await updateIssue(root, id, patch, actor ?? "mcp");
        return toContent(okResult(issue));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  server.registerTool(
    "close_issue",
    {
      description: "Close an issue with a resolution",
      inputSchema: {
        id: RecordId.describe("issue id"),
        resolution: z.string().describe("resolution summary"),
        actor: z.string().optional().describe("mutation actor (default: mcp)"),
      },
    },
    async ({ id, resolution, actor }) => {
      try {
        const issue = await closeIssue(root, id, resolution, actor ?? "mcp");
        return toContent(okResult(issue));
      } catch (e) {
        return toContent(toResult(null, [catchDiag(e)]));
      }
    },
  );

  // ── prompt introspection ──

  server.registerTool("list_prompts", { description: "List all prompt records" }, async () => {
    const prompts = loadPrompts(root);
    return toContent(okResult(prompts));
  });

  return server;
}
