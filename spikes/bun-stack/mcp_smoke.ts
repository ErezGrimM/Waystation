import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "waystation-bun-spike",
  version: "0.0.0",
});

server.registerTool(
  "ping",
  {
    description: "Return a small MCP smoke-test response.",
    inputSchema: { message: z.string().optional() },
  },
  ({ message }: { message?: string }) => ({
    content: [{ type: "text", text: message ?? "pong" }],
  }),
);

if (process.argv.includes("--smoke")) {
  console.log("MCP SDK imports and server registration succeeded under Bun.");
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

