import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  event_type: z.string(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  conversation_id: z.string(),
};

export function register(server: McpServer) {
  server.registerTool(
    "log_conversation_event",
    {
      description: "Record an important agent action or decision.",
      inputSchema,
    },
    withToolLogging("log_conversation_event", "Record an important agent action or decision.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
