/**
 * Typed command specification for the Waystation CLI.
 *
 * This is the single source of truth for command names, options, help text,
 * and argument arity. The parser derives help output and validation from it.
 */

export interface OptionSpec {
  /** Long flag name without leading dashes, e.g. "title" */
  name: string;
  /** Display form for help, e.g. "--title <title>" or "--force" */
  flag: string;
  description: string;
  required?: boolean;
  default?: string | boolean;
  /** Option accepts one or more values (space-separated or repeated) */
  variadic?: boolean;
}

export interface ArgumentSpec {
  name: string;
  description: string;
  required: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  options: OptionSpec[];
  arguments: ArgumentSpec[];
  subcommands: CommandSpec[];
  /** Extra guidance shown under "Notes:" in this command's help */
  notes?: string[];
  /** Action handler — receives parsed options and positional arguments */
  action?: (ctx: CommandContext) => Promise<void> | void;
}

export interface CommandContext {
  /** Parsed option values keyed by option name */
  opts: Record<string, string | string[] | boolean | undefined>;
  /** Positional arguments */
  args: string[];
  /** Global --root value */
  root: string | undefined;
  /** Global --json flag */
  json: boolean;
  /** The full raw argv (for special cases) */
  raw: string[];
}

// ─── Command tree ────────────────────────────────────────────────────────────

export const GLOBAL_OPTIONS: OptionSpec[] = [
  {
    name: "root",
    flag: "--root <path>",
    description: "ledger root (overrides WAYSTATION_ROOT and upward discovery)",
  },
  {
    name: "json",
    flag: "--json",
    description: "output JSON",
  },
];

/** Cross-cutting guidance shown at the bottom of global help. */
export const GLOBAL_NOTES: string[] = [
  "Ledger location: --root, then WAYSTATION_ROOT, then the nearest .waystation/ found upward.",
  `With config git.ledger_root "main_worktree", a linked git worktree is redirected to the MAIN checkout ledger. All branches and sessions share one working tree of ledger files, so edits from other sessions can sit uncommitted beside yours. Commit only the ledger files you changed.`,
  "Commit a task together with every scope record it references; a task committed alone fails validation elsewhere.",
  "Claims record the git branch and worktree they were made from; 'task claim --branch/--worktree' overrides them.",
  "Read-only checks: validate, task list/show/next/ready, inbox. Writers: sync, report, reindex, repair, and every task/message/handoff mutation.",
  "Cancel a task that is not claimed or finished with: task set-status <id> wont_do (undo with task reopen).",
];

export const COMMAND_TREE: CommandSpec[] = [
  {
    name: "init",
    description: "Scaffold a new .waystation/ ledger in the current directory",
    options: [
      { name: "project", flag: "--project <id>", description: "project id (default: folder name)" },
      {
        name: "force",
        flag: "--force",
        description:
          "re-scaffold an existing ledger: rewrites config.json and recreates missing directories; records, messages, and event history are PRESERVED (not a wipe)",
      },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
  },
  {
    name: "task",
    description: "Task commands",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "next",
        description: "Show the next declared-ready task whose dependencies are done or wont_do",
        options: [
          { name: "json", flag: "--json", description: "output JSON" },
          {
            name: "fromIndex",
            flag: "--from-index",
            description: "resolve via the SQLite index instead of in-memory",
          },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "ready",
        description: "List actionable declared-ready tasks, best-first",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [],
        subcommands: [],
      },
      {
        name: "list",
        description: "List all tasks with their status",
        options: [
          { name: "json", flag: "--json", description: "output JSON" },
          { name: "status", flag: "--status <status>", description: "filter by status" },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "audit",
        description: "List dependency-satisfied todo tasks (candidates for intentional promotion)",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [],
        subcommands: [],
      },
      {
        name: "show",
        description: "Show a single task",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
      {
        name: "create",
        description: "Create a task through the canonical core mutation path",
        options: [
          { name: "title", flag: "--title <title>", description: "task title", required: true },
          {
            name: "status",
            flag: "--status <status>",
            description: "initial status",
            default: "todo",
          },
          {
            name: "priority",
            flag: "--priority <number>",
            description: "numeric priority",
            default: "3",
          },
          { name: "scope", flag: "--scope <id>", description: "scope id" },
          {
            name: "pathHint",
            flag: "--path-hint <path...>",
            description: "path hint(s)",
            variadic: true,
          },
          { name: "prompt", flag: "--prompt <id...>", description: "prompt id(s)", variadic: true },
          {
            name: "dependsOn",
            flag: "--depends-on <id...>",
            description: "dependency task id(s)",
            variadic: true,
          },
          { name: "description", flag: "--description <text>", description: "task description" },
          {
            name: "acceptance",
            flag: "--acceptance <text...>",
            description: "acceptance criterion/criteria",
            variadic: true,
          },
          { name: "notes", flag: "--notes <text>", description: "coordination notes" },
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
        notes: [
          "Usage: waystation task create <id> --title <title> [options]. The id is the first positional argument.",
          "Commit the referenced scope record (--scope) in the same commit as the task.",
        ],
      },
      {
        name: "update",
        description: "Update mutable task fields without changing lifecycle status",
        options: [
          { name: "title", flag: "--title <title>", description: "task title" },
          { name: "priority", flag: "--priority <number>", description: "numeric priority" },
          { name: "scope", flag: "--scope <id>", description: "scope id" },
          {
            name: "pathHint",
            flag: "--path-hint <path...>",
            description: "replace path hints",
            variadic: true,
          },
          {
            name: "clearPathHints",
            flag: "--clear-path-hints",
            description: "clear all path hints",
          },
          {
            name: "prompt",
            flag: "--prompt <id...>",
            description: "replace prompt ids",
            variadic: true,
          },
          { name: "clearPrompts", flag: "--clear-prompts", description: "clear all prompt ids" },
          {
            name: "dependsOn",
            flag: "--depends-on <id...>",
            description: "replace dependency task ids",
            variadic: true,
          },
          {
            name: "clearDependencies",
            flag: "--clear-dependencies",
            description: "clear all dependency task ids",
          },
          { name: "description", flag: "--description <text>", description: "task description" },
          {
            name: "acceptance",
            flag: "--acceptance <text...>",
            description: "replace acceptance criteria",
            variadic: true,
          },
          {
            name: "clearAcceptance",
            flag: "--clear-acceptance",
            description: "clear all acceptance criteria",
          },
          { name: "notes", flag: "--notes <text>", description: "coordination notes" },
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
      {
        name: "set-status",
        description: "Apply a valid non-claim task status transition",
        options: [
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [
          { name: "id", description: "task id", required: true },
          { name: "status", description: "target task status", required: true },
        ],
        subcommands: [],
        notes: [
          "Allowed: todo -> ready|wont_do; ready -> todo|blocked|wont_do; blocked -> todo|ready|wont_do; review -> ready|done.",
          "in_progress is reached only by 'task claim'; leave it with release or finish. done/wont_do are terminal: use 'task reopen'.",
          "To cancel a task, set it to wont_do.",
        ],
      },
      {
        name: "reopen",
        description: "Reopen a done or wont_do task",
        options: [
          {
            name: "status",
            flag: "--status <status>",
            description: "reopened status: todo or ready",
            required: true,
          },
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
      {
        name: "claim",
        description: "Claim a task (creates an active claim, moves task to in_progress)",
        options: [
          { name: "agent", flag: "--agent <agent>", description: "claiming agent", required: true },
          {
            name: "branch",
            flag: "--branch <branch>",
            description: "git branch to record on the claim",
          },
          {
            name: "worktree",
            flag: "--worktree <path>",
            description: "git worktree path to record on the claim",
          },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
      {
        name: "release",
        description: "Release the active claim on a task (moves task back to ready)",
        options: [
          {
            name: "agent",
            flag: "--agent <agent>",
            description: "releasing agent",
            required: true,
          },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
      {
        name: "finish",
        description: "Finish a task (marks it done and completes any active claim)",
        options: [
          {
            name: "agent",
            flag: "--agent <agent>",
            description: "finishing agent",
            required: true,
          },
          {
            name: "commit",
            flag: "--commit <sha...>",
            description: "commit hash(es) to attach to the task",
            variadic: true,
          },
          {
            name: "commitHead",
            flag: "--commit-head",
            description: "attach the current git HEAD commit",
          },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "task id", required: true }],
        subcommands: [],
      },
    ],
  },
  {
    name: "issue",
    description: "Issue commands",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "list",
        description: "List issue records",
        options: [
          { name: "status", flag: "--status <status>", description: "filter by status" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "show",
        description: "Show a single issue and its preserved context",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [{ name: "id", description: "issue id", required: true }],
        subcommands: [],
      },
      {
        name: "create",
        description: "Create an issue through the canonical core mutation path",
        options: [
          { name: "title", flag: "--title <title>", description: "issue title", required: true },
          { name: "id", flag: "--id <id>", description: "explicit issue id" },
          { name: "status", flag: "--status <status>", description: "initial status" },
          { name: "severity", flag: "--severity <severity>", description: "issue severity" },
          { name: "type", flag: "--type <type>", description: "issue type" },
          { name: "priority", flag: "--priority <number>", description: "numeric priority" },
          { name: "task", flag: "--task <id>", description: "linked task id" },
          { name: "scope", flag: "--scope <id>", description: "scope id" },
          { name: "description", flag: "--description <text>", description: "issue description" },
          { name: "evidence", flag: "--evidence <text>", description: "textual evidence" },
          { name: "expected", flag: "--expected <text>", description: "expected behavior" },
          { name: "actual", flag: "--actual <text>", description: "actual behavior" },
          {
            name: "acceptance",
            flag: "--acceptance <text...>",
            description: "acceptance criterion/criteria",
            variadic: true,
          },
          { name: "resolution", flag: "--resolution <text>", description: "resolution text" },
          { name: "notes", flag: "--notes <text>", description: "issue notes" },
          { name: "source", flag: "--source <json>", description: "source metadata as JSON" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "update",
        description: "Update mutable issue fields",
        options: [
          { name: "title", flag: "--title <title>", description: "issue title" },
          { name: "status", flag: "--status <status>", description: "issue status" },
          { name: "severity", flag: "--severity <severity>", description: "issue severity" },
          { name: "type", flag: "--type <type>", description: "issue type" },
          { name: "priority", flag: "--priority <number>", description: "numeric priority" },
          { name: "task", flag: "--task <id>", description: "linked task id" },
          { name: "scope", flag: "--scope <id>", description: "scope id" },
          { name: "description", flag: "--description <text>", description: "issue description" },
          { name: "evidence", flag: "--evidence <text>", description: "textual evidence" },
          { name: "expected", flag: "--expected <text>", description: "expected behavior" },
          { name: "actual", flag: "--actual <text>", description: "actual behavior" },
          {
            name: "acceptance",
            flag: "--acceptance <text...>",
            description: "replace acceptance criteria",
            variadic: true,
          },
          {
            name: "clearAcceptance",
            flag: "--clear-acceptance",
            description: "clear all acceptance criteria",
          },
          { name: "resolution", flag: "--resolution <text>", description: "resolution text" },
          { name: "notes", flag: "--notes <text>", description: "issue notes" },
          { name: "source", flag: "--source <json>", description: "source metadata as JSON" },
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "issue id", required: true }],
        subcommands: [],
      },
      {
        name: "close",
        description: "Close an issue with a resolution",
        options: [
          {
            name: "resolution",
            flag: "--resolution <text>",
            description: "resolution summary",
            required: true,
          },
          { name: "actor", flag: "--actor <actor>", description: "mutation actor", default: "cli" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [{ name: "id", description: "issue id", required: true }],
        subcommands: [],
      },
    ],
  },
  {
    name: "brief",
    description:
      "Generate a task-scoped context brief (auto-detects task from git claim if --task is omitted)",
    options: [
      {
        name: "task",
        flag: "--task <id>",
        description: "task id (auto-detected from current git branch claim if omitted)",
      },
      {
        name: "budget",
        flag: "--budget <budget>",
        description: "small|medium|large|full (defaults to project config)",
      },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
  },
  {
    name: "validate",
    description: "Validate the ledger (schemas, references, cycles, claims, events)",
    options: [
      {
        name: "project",
        flag: "--project",
        description: "also validate caller-project paths and generated report freshness",
      },
      {
        name: "views",
        flag: "--views",
        description: "also freshness-check generated task views (implies --project)",
      },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
    notes: [
      "Read-only: never writes ledger files. Use this, not sync, for a health check.",
      "Warns when a task references a scope record that does not exist.",
    ],
  },
  {
    name: "reindex",
    description: "Rebuild the SQLite index from canonical records",
    options: [{ name: "json", flag: "--json", description: "output JSON" }],
    arguments: [],
    subcommands: [],
    notes: [
      "Writes the index under the resolved ledger root (see 'waystation --help' for how the root is chosen).",
    ],
  },
  {
    name: "repair",
    description: "Repair events.jsonl: split }{-concatenated lines, normalize trailing newlines",
    options: [{ name: "json", flag: "--json", description: "output JSON" }],
    arguments: [],
    subcommands: [],
  },
  {
    name: "report",
    description:
      "Regenerate STATUS.md and context files (active-work.md, blocked.md) from the ledger",
    options: [
      { name: "views", flag: "--views", description: "also regenerate views/tasks/*.md" },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
    notes: [
      "Writes report files into the resolved ledger root. In main_worktree mode that is the main checkout, shared with other sessions: review git status there before committing.",
    ],
  },
  {
    name: "sync",
    description: "Validate, reindex, regenerate reports, and verify project freshness",
    options: [
      {
        name: "views",
        flag: "--views",
        description: "also regenerate and validate views/tasks/*.md",
      },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
    notes: [
      "NOT read-only: rewrites the index and generated reports/views in the resolved ledger root. In main_worktree mode that is the main checkout, so changes can mix with other sessions' uncommitted edits. For a read-only check use 'validate'.",
    ],
  },
  {
    name: "handoff",
    description: "Agent handoffs (baton pass)",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "create",
        description: "Create a handoff for a task",
        options: [
          { name: "task", flag: "--task <id>", description: "task id", required: true },
          {
            name: "from",
            flag: "--from <agent>",
            description: "handing-off agent",
            required: true,
          },
          {
            name: "to",
            flag: "--to <agent>",
            description: "receiving agent (omit for next available)",
          },
          { name: "summary", flag: "--summary <text>", description: "summary of current state" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "show",
        description: "Show a handoff",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [{ name: "id", description: "handoff id", required: true }],
        subcommands: [],
      },
    ],
  },
  {
    name: "prompt",
    description: "Prompt records",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "list",
        description: "List prompt records",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [],
        subcommands: [],
      },
      {
        name: "show",
        description: "Show a prompt record",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [{ name: "id", description: "prompt id", required: true }],
        subcommands: [],
      },
      {
        name: "render",
        description: "Render applicable prompts for a task/agent (spec §11)",
        options: [
          { name: "task", flag: "--task <id>", description: "task id", required: true },
          { name: "agent", flag: "--agent <agent>", description: "agent name", required: true },
          { name: "role", flag: "--role <role>", description: "agent role" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
    ],
  },
  {
    name: "message",
    description: "Agent messages (async inbox)",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "post",
        description: "Post a message to a thread (a task/issue id or 'project')",
        options: [
          {
            name: "thread",
            flag: "--thread <id>",
            description: "task/issue id, or 'project' for the folder-wide channel",
            required: true,
          },
          { name: "from", flag: "--from <agent>", description: "author", required: true },
          {
            name: "to",
            flag: "--to <agent>",
            description: "recipient; omit to broadcast to the thread",
          },
          {
            name: "kind",
            flag: "--kind <kind>",
            description: "update|question|verdict|note",
            default: "update",
          },
          { name: "body", flag: "--body <text>", description: "message body", required: true },
          {
            name: "inReplyTo",
            flag: "--in-reply-to <id>",
            description: "message id this replies to",
          },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "list",
        description: "List messages on a thread, oldest first",
        options: [
          { name: "thread", flag: "--thread <id>", description: "thread id", required: true },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
    ],
  },
  {
    name: "inbox",
    description:
      "Show messages addressed to an agent (direct, project channel, or claimed threads)",
    options: [
      {
        name: "agent",
        flag: "--agent <agent>",
        description: "agent whose inbox to read",
        required: true,
      },
      {
        name: "since",
        flag: "--since <cursor>",
        description: "ISO timestamp; only messages after it",
      },
      { name: "json", flag: "--json", description: "output JSON" },
    ],
    arguments: [],
    subcommands: [],
  },
  {
    name: "ledger",
    description: "Uncommitted ledger files: who wrote them, and committing one actor's share",
    options: [],
    arguments: [],
    notes: [
      "Each mutation records the files it wrote, so uncommitted ledger files can be attributed to the actor that wrote them.",
      "'ledger commit' builds a commit from a temporary index and writes it to a branch. HEAD, the index and the working tree of every checkout are left untouched.",
    ],
    subcommands: [
      {
        name: "status",
        description: "List uncommitted ledger files grouped by the actor that wrote them",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [],
        notes: [
          "Read-only. 'unattributed' files were not written through Waystation (hand edits); 'generated' files come from report/sync.",
        ],
        subcommands: [],
      },
      {
        name: "commit",
        description: "Commit only one actor's uncommitted ledger files to a branch",
        options: [
          {
            name: "agent",
            flag: "--agent <name>",
            description: "actor whose files to commit",
            required: true,
          },
          {
            name: "branch",
            flag: "--branch <name>",
            description: "target branch (default: ledger/<agent>); must not be checked out",
          },
          { name: "message", flag: "--message <text>", description: "commit message" },
          { name: "dryRun", flag: "--dry-run", description: "show what would be committed" },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        notes: [
          "Includes the scope and prompt records the actor's tasks reference, and only that actor's events.",
          "The files stay modified in the shared checkout; after merging the branch, 'git checkout -- <files>' drops the duplicates.",
        ],
        subcommands: [],
      },
    ],
  },
  {
    name: "git",
    description: "Git/worktree commands",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "status",
        description: "Show current git branch, worktree, and status summary",
        options: [{ name: "json", flag: "--json", description: "output JSON" }],
        arguments: [],
        subcommands: [],
      },
    ],
  },
  {
    name: "mcp",
    description: "Start an MCP stdio server for coding agent integration",
    options: [],
    arguments: [],
    subcommands: [],
  },
  {
    name: "gh",
    description: "GitHub Issues integration",
    options: [],
    arguments: [],
    subcommands: [
      {
        name: "import",
        description: "Import issues from a GitHub repository into the ledger",
        options: [
          {
            name: "repo",
            flag: "--repo <repo>",
            description: "repository (owner/name)",
            required: true,
          },
          { name: "json", flag: "--json", description: "output JSON" },
          {
            name: "force",
            flag: "--force",
            description: "overwrite existing gh-<number> records with current GitHub state",
          },
        ],
        arguments: [],
        subcommands: [],
      },
      {
        name: "export",
        description: "Export ledger issues to a GitHub repository",
        options: [
          {
            name: "repo",
            flag: "--repo <repo>",
            description: "repository (owner/name)",
            required: true,
          },
          { name: "json", flag: "--json", description: "output JSON" },
        ],
        arguments: [],
        subcommands: [],
      },
    ],
  },
  {
    name: "dashboard",
    description: "Start the local dashboard web UI (http://127.0.0.1:8787)",
    options: [
      {
        name: "dev",
        flag: "--dev",
        description: "start Vite dev server alongside and proxy to it",
      },
      { name: "port", flag: "--port <port>", description: "port", default: "8787" },
    ],
    arguments: [],
    subcommands: [],
  },
];
