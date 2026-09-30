import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  ticket_id: z.string().optional(),
  customer_id: z.string().optional(),
  user_name: z.string(),
  user_email: z.string().email(),
  category: z.enum(["compliance", "account", "dispute", "payment", "other"]),
  reason: z.string(),
  preferred_time: z.string().optional(),
  conversation_id: z.string().optional(),
};

export function register(server: McpServer) {
  server.registerTool(
    "create_escalation",
    {
      description: "Hand the case to a human specialist and book a callback.",
      inputSchema,
    },
    withToolLogging("create_escalation", "Hand the case to a human specialist and book a callback.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
