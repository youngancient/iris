import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "../lib/withToolLogging.js";

const inputSchema = {
  customer_id: z.string().optional(),
  email: z.string().email().optional(),
  company_name: z.string().optional(),
  conversation_id: z.string().optional(),
};

export function register(server: McpServer) {
  server.registerTool(
    "lookup_customer",
    {
      description: "Find a customer record when the user has given a customer ID, email, or company name.",
      inputSchema,
    },
    withToolLogging("lookup_customer", "Find a customer record when the user has given a customer ID, email, or company name.", async (input) => {
      // TODO: implement against Supabase
      void input;
      return { status: "error", data: { error: "not implemented" } };
    }),
  );
}
