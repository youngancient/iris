#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSupabaseDb } from "./db/supabaseDb.js";
import { createApp } from "./http.js";
import { buildServer } from "./server.js";

// stdout is the MCP channel in stdio mode, so everything human-readable goes to stderr.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return value;
}

const db = createSupabaseDb(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));

if (process.argv.includes("--stdio")) {
  // Local dev only: one conversation for the life of the process.
  const server = buildServer({ db, conversationId: process.env.MCP_CONVERSATION_ID ?? null, turnIndex: null });
  await server.connect(new StdioServerTransport());
  console.error("relaypay-support MCP server running on stdio");
} else {
  const token = required("MCP_TOKEN");
  if (token.length < 32) {
    console.error("MCP_TOKEN must be at least 32 characters");
    process.exit(1);
  }
  const port = Number(process.env.MCP_PORT ?? 8788);
  const app = createApp({ db, token, readinessCheck: async () => void (await db.customerById("CUS-0000")) });
  app.listen(port, () => console.error(`relaypay-support MCP server listening on :${port}/mcp`));
}
