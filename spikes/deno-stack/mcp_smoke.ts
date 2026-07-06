import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "waystation-deno-spike",
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

if (Deno.args.includes("--smoke")) {
  console.log("MCP SDK imports and server registration succeeded under Deno.");
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
