import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  customer_id: z.string().optional(),
  category: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  summary: z.string(),
  conversation_id: z.string(),
};

export function register(server: McpServer) {
  server.registerTool(
    "create_support_ticket",
    {
      description: "Log an issue for support team follow-up.",
      inputSchema,
    },
    withToolLogging("create_support_ticket", "Log an issue for support team follow-up.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
