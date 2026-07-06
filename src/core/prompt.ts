import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { loadTasks, RecordError } from "./records.ts";
import { type PromptRecord, PromptRecord as PromptSchema } from "./schema.ts";
import { readJsonFile } from "./store.ts";

function promptsDir(root?: string): string {
  return join(ledgerPaths(root).ledger, "prompts");
}

/** Load and validate all prompt records. */
export function loadPrompts(root?: string): PromptRecord[] {
  const dir = promptsDir(root);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const prompts: PromptRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const parsed = PromptSchema.safeParse(readJsonFile(file));
    if (!parsed.success) {
      throw new RecordError(
        file,
        `schema: ${parsed.error.issues[0]?.message ?? "invalid prompt"}`,
        "schema_invalid",
      );
    }
    prompts.push(parsed.data);
  }
  return prompts;
}

export function getPrompt(root: string, id: string): PromptRecord | undefined {
  return loadPrompts(root).find((p) => p.id === id);
}

export interface PromptContext {
  agent?: string;
  role?: string;
  scope?: string;
  task?: string;
}

/** Specificity of a prompt's match, low→high (spec §11 precedence order). */
function specificity(p: PromptRecord, ctx: PromptContext): number {
  const a = p.applies_to;
  if (ctx.task && a.tasks.includes(ctx.task)) return 4;
  if (ctx.scope && a.scopes.includes(ctx.scope)) return 3;
  if (ctx.role && a.roles.includes(ctx.role)) return 2;
  if (ctx.agent && a.agents.includes(ctx.agent)) return 1;
  return 0; // global (empty applies_to)
}

function isGlobal(p: PromptRecord): boolean {
  const a = p.applies_to;
  return !a.agents.length && !a.roles.length && !a.scopes.length && !a.tasks.length;
}

function applies(p: PromptRecord, ctx: PromptContext, taskPromptIds: Set<string>): boolean {
  if (p.status !== "active") return false;
  if (isGlobal(p)) return true;
  if (taskPromptIds.has(p.id)) return true;
  return specificity(p, ctx) > 0;
}

/**
 * Select the active prompts that apply to a context, ordered by precedence
 * (global → agent → role → scope → task; ties broken by priority then id).
 * If `ctx.task` is given, the task's own `prompts` list and `scope` are folded in.
 */
export function selectPrompts(root: string, ctx: PromptContext): PromptRecord[] {
  const resolved: PromptContext = { ...ctx };
  const taskPromptIds = new Set<string>();
  if (ctx.task) {
    const task = loadTasks(root).find((t) => t.id === ctx.task);
    if (task) {
      if (!resolved.scope && task.scope) resolved.scope = task.scope;
      for (const id of task.prompts) taskPromptIds.add(id);
    }
  }
  return loadPrompts(root)
    .filter((p) => applies(p, resolved, taskPromptIds))
    .sort(
      (a, b) =>
        specificity(a, resolved) - specificity(b, resolved) ||
        a.priority - b.priority ||
        a.id.localeCompare(b.id),
    );
}

export interface RenderVars {
  task_id?: string;
  agent?: string;
  scope?: string;
  branch?: string;
  worktree?: string;
}

/** Substitute {{var}} placeholders; unknown placeholders are left intact. */
export function substitute(text: string, vars: RenderVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v ?? `{{${key}}}`;
  });
}

/** Render one prompt to text with variables substituted. */
export function renderPrompt(p: PromptRecord, vars: RenderVars): string {
  const lines: string[] = [`# ${p.id} (v${p.version})  ${p.title}`];
  if (p.purpose) lines.push("", substitute(p.purpose.trim(), vars));
  if (p.instructions) lines.push("", "## Instructions", substitute(p.instructions.trim(), vars));
  if (p.must_do.length) {
    lines.push("", "## Must do", ...p.must_do.map((s) => `- ${substitute(s, vars)}`));
  }
  if (p.must_not.length) {
    lines.push("", "## Must not", ...p.must_not.map((s) => `- ${substitute(s, vars)}`));
  }
  if (p.commands) {
    lines.push("", "## Commands");
    for (const [phase, cmds] of Object.entries(p.commands)) {
      for (const c of cmds) lines.push(`- [${phase}] ${substitute(c, vars)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Render all applicable prompts for a context, concatenated in precedence order. */
export function renderSelected(root: string, ctx: PromptContext, vars: RenderVars): string {
  const selected = selectPrompts(root, ctx);
  if (selected.length === 0) return "No applicable prompts.\n";
  return selected.map((p) => renderPrompt(p, vars)).join("\n---\n\n");
}
