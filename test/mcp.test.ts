import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * task-mcp-smoke: proves @modelcontextprotocol/sdk imports and runs on Bun —
 * construct a server, register a tool, and round-trip a call from a client over
 * an in-memory transport. De-risks Phase 4 (the MCP server).
 */
describe("mcp sdk smoke (Bun)", () => {
  test("server + client round trip over an in-memory transport", async () => {
    const server = new McpServer({ name: "waystation-smoke", version: "0.0.1" });
    server.registerTool(
      "ping",
      { description: "echo back a message", inputSchema: { msg: z.string() } },
      async ({ msg }) => ({ content: [{ type: "text", text: `pong: ${msg}` }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "smoke-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");

    const res = await client.callTool({ name: "ping", arguments: { msg: "hi" } });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    expect(first?.text).toBe("pong: hi");

    await client.close();
    await server.close();
  });
});
