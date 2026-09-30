import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  transaction_id: z.string(),
  conversation_id: z.string().optional(),
};

export function register(server: McpServer) {
  server.registerTool(
    "lookup_transaction",
    {
      description: "Look up a transaction by the reference the user provided.",
      inputSchema,
    },
    withToolLogging("lookup_transaction", "Look up a transaction by the reference the user provided.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
