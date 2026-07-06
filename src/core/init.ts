import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ledgerPaths } from "./paths.ts";
import { type CommandResult, diag, okResult } from "./result.ts";
import { appendEvent, writeJsonAtomic } from "./store.ts";
import { nowIso } from "./time.ts";

const SUBDIRS = [
  "tasks",
  "issues",
  "prompts",
  "scopes",
  "claims",
  "handoffs",
  "decisions",
  "messages",
  "reports",
  "context",
  "views",
];

export interface InitResult {
  root: string;
  created: boolean;
  project: string;
}

/** Scaffold a fresh .waystation/ ledger. Idempotent unless `force`. */
export function initLedger(
  root: string,
  opts: { project?: string; force?: boolean } = {},
): CommandResult<InitResult> {
  const paths = ledgerPaths(root);
  const project = opts.project ?? (basename(root) || "project");

  if (existsSync(paths.ledger) && !opts.force) {
    return okResult({ root, created: false, project }, [
      diag("already_initialized", { details: { ledger: paths.ledger } }),
    ]);
  }

  mkdirSync(paths.ledger, { recursive: true });
  for (const d of SUBDIRS) mkdirSync(join(paths.ledger, d), { recursive: true });

  writeJsonAtomic(paths.config, {
    version: 1,
    project_id: project,
    project_name: project,
    root: ".",
    defaults: {
      agent: "unknown",
      brief_budget: "medium",
      status_report: ".waystation/reports/STATUS.md",
    },
    id_rules: {
      task_prefix: "task",
      issue_prefix: "issue",
      prompt_prefix: "prompt",
      scope_prefix: "scope",
    },
    git: { track_branches: true, track_worktrees: true },
    generated_views: { enabled: true },
  });

  if (!existsSync(paths.events)) writeFileSync(paths.events, "");
  appendEvent(root, { type: "project.initialized", project, actor: "waystation", ts: nowIso() });

  return okResult({ root, created: true, project });
}
