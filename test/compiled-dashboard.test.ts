import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "waystation compiled dashboard "));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function outputText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function run(args: string[], cwd: string = projectRoot): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${args.join(" ")}\n${outputText(result.stderr)}`,
    );
  }
  return outputText(result.stdout);
}

function setupLedger(root: string): void {
  const ledgerDir = join(root, ".waystation");
  for (const dir of ["tasks", "claims", "messages", "issues", "handoffs", "prompts", "scopes"])
    mkdirSync(join(ledgerDir, dir), { recursive: true });
  writeFileSync(join(ledgerDir, "events.jsonl"), "");
  writeFileSync(
    join(ledgerDir, "tasks", "compiled-smoke.json"),
    JSON.stringify(
      {
        id: "compiled-smoke",
        title: "Compiled smoke",
        status: "ready",
        priority: 1,
        dependencies: [],
        prompts: [],
        path_hints: [],
        acceptance: [],
        created_at: "2026-08-28T00:00:00+03:00",
        updated_at: "2026-08-28T00:00:00+03:00",
        description: "Fixture for the embedded dashboard executable.",
      },
      null,
      2,
    ),
  );
  const graphDir = join(root, "graphify-out");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
}

async function freePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a dashboard smoke-test port.");
  return port;
}

async function waitForDashboard(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError;
}

describe("compiled dashboard distribution", () => {
  test("copied executable serves embedded SPA/API/graph assets and MCP from an unrelated project", async () => {
    const buildDir = join(tempRoot, "build");
    const runtimeDir = join(tempRoot, "runtime with spaces");
    const ledgerRoot = join(tempRoot, "unrelated project with spaces");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(ledgerRoot, { recursive: true });
    setupLedger(ledgerRoot);

    run([process.execPath, "run", "dashboard:build"]);
    const builtExe = join(buildDir, "waystation.exe");
    run([
      process.execPath,
      "build",
      "--compile",
      "src/cli/index.ts",
      "--asset",
      "src/dashboard/client/dist",
      "--outfile",
      builtExe,
    ]);

    const exe = join(runtimeDir, "waystation.exe");
    copyFileSync(builtExe, exe);
    rmSync(buildDir, { recursive: true, force: true });
    expect(run([exe, "--version"], runtimeDir).trim()).toBe("0.5.0");
    run([exe, "--root", ledgerRoot, "validate"], runtimeDir);

    const transport = new StdioClientTransport({
      command: exe,
      args: ["--root", ledgerRoot, "mcp"],
      cwd: runtimeDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "compiled-smoke", version: "0.0.1" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("validate_ledger");
      const validation = await client.callTool({ name: "validate_ledger", arguments: {} });
      const first = (validation.content as Array<{ text?: string }>)[0];
      expect(JSON.parse(first?.text ?? "{}").ok).toBe(true);
    } finally {
      await client.close();
    }

    const port = await freePort();
    const server = Bun.spawn([exe, "--root", ledgerRoot, "dashboard", "--port", String(port)], {
      cwd: runtimeDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      const index = await waitForDashboard(`${base}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      const html = await index.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1]!,
      );
      expect(assets.length).toBeGreaterThan(0);

      const asset = await fetch(`${base}${assets[0]}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toMatch(/javascript|text\/css/);

      const spa = await fetch(`${base}/tasks/compiled-smoke`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain(assets[0]!);

      const api = await fetch(`${base}/api/status`);
      expect(api.status).toBe(200);
      const apiBody = await api.json();
      expect(apiBody.ok).toBe(true);
      expect(apiBody.data.ledgerRoot).toBe(ledgerRoot);

      const graph = await fetch(`${base}/graphify-out/graph.json`);
      expect(graph.status).toBe(200);
      expect(graph.headers.get("content-type")).toContain("application/json");

      const missing = await fetch(`${base}/assets/missing.js`);
      expect(missing.status).toBe(404);

      const traversal = await fetch(`${base}/assets/%2e%2e%2findex.html`);
      expect(traversal.status).toBe(404);

      if (html.includes("/favicon.ico")) {
        expect((await fetch(`${base}/favicon.ico`)).status).toBe(200);
      }
    } finally {
      server.kill();
      await server.exited;
    }
  }, 60_000);
});
