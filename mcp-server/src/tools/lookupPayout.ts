import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  payout_id: z.string().optional(),
  transaction_id: z.string().optional(),
  conversation_id: z.string().optional(),
};

export function register(server: McpServer) {
  server.registerTool(
    "lookup_payout",
    {
      description: "Look up a contractor payout by payout ID or linked transaction ID.",
      inputSchema,
    },
    withToolLogging("lookup_payout", "Look up a contractor payout by payout ID or linked transaction ID.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
