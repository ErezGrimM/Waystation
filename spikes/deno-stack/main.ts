import { Command } from "commander";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { z } from "zod";

const VERSION = "0.0.0-deno-spike";

const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum([
    "todo",
    "ready",
    "in_progress",
    "blocked",
    "review",
    "done",
    "wont_do",
  ]),
  priority: z.number().int().optional(),
  scope: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
});

type Task = z.infer<typeof TaskSchema>;

if (Deno.args.includes("--version")) {
  console.log(VERSION);
  Deno.exit(0);
}

function repoRoot(): string {
  let dir = Deno.cwd().replaceAll("\\", "/");

  while (true) {
    try {
      const stat = Deno.statSync(`${dir}/.waystation`);
      if (stat.isDirectory) return dir;
    } catch {
      // Keep walking upward until the filesystem root.
    }

    const parent = dir.replace(/\/[^/]+$/, "");
    if (parent === dir) {
      throw new Error("Could not find .waystation in current directory or parents.");
    }
    dir = parent;
  }
}

function waystationDir(): string {
  return `${repoRoot()}/.waystation`;
}

async function loadTasks(): Promise<Task[]> {
  const tasksDir = `${waystationDir()}/tasks`;
  const tasks: Task[] = [];

  for await (const entry of Deno.readDir(tasksDir)) {
    if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
    const path = `${tasksDir}/${entry.name}`;
    const raw = await Deno.readTextFile(path);
    const parsed = parse(raw);
    tasks.push(TaskSchema.parse(parsed));
  }

  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

async function reindex(): Promise<{ count: number; path: string }> {
  const tasks = await loadTasks();
  const dbPath = `${waystationDir()}/index-spike.sqlite`;
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    DROP TABLE IF EXISTS tasks;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT
    );
  `);

  const insert = db.prepare(
    "INSERT INTO tasks (id, title, status, scope) VALUES (?, ?, ?, ?)",
  );
  for (const task of tasks) {
    insert.run(task.id, task.title, task.status, task.scope ?? null);
  }

  const count = db.prepare("SELECT count(*) AS count FROM tasks").get() as {
    count: number;
  };
  db.close();

  return { count: count.count, path: dbPath };
}

const program = new Command();

program
  .name("waystation-spike")
  .description("Deno stack spike for Waystation")
  .version(VERSION);

program
  .command("task list")
  .description("Load and validate current Waystation task YAML files")
  .action(async () => {
    const tasks = await loadTasks();
    for (const task of tasks) {
      console.log(`${task.id}\t${task.status}\t${task.title}`);
    }
  });

program
  .command("reindex")
  .description("Build a disposable SQLite index from task YAML files")
  .action(async () => {
    const result = await reindex();
    console.log(`indexed ${result.count} tasks at ${result.path}`);
  });

program
  .command("serve")
  .description("Serve a tiny dashboard API/page")
  .option("--port <port>", "port", "8787")
  .action(async (options: { port: string }) => {
    const app = new Hono();

    app.get("/", (c) => c.html("<h1>Waystation Deno Spike</h1>"));
    app.get("/api/tasks", async (c) => c.json(await loadTasks()));

    const port = Number(options.port);
    console.error(`Serving http://127.0.0.1:${port}`);
    Deno.serve({ hostname: "127.0.0.1", port }, app.fetch);
  });

await program.parseAsync(Deno.args, { from: "user" });
