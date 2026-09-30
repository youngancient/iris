#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSupabaseDb } from "./db/supabaseDb.js";
import { exitOnEnvError, optionalInt, requireSecret, requireUrl } from "./env.js";
import { createApp } from "./http.js";
import { buildServer } from "./server.js";

// stdout is the MCP channel in stdio mode, so everything human-readable goes to stderr.
const stdio = process.argv.includes("--stdio");

let config;
try {
  config = {
    supabaseUrl: requireUrl("SUPABASE_URL"),
    supabaseKey: requireSecret("SUPABASE_SERVICE_ROLE_KEY", 20),
    // HTTP mode only: stdio is a local pipe with no network exposure.
    mcpToken: stdio ? null : requireSecret("MCP_TOKEN", 32),
    port: optionalInt("MCP_PORT", 8788, 1, 65535),
  };
} catch (err) {
  exitOnEnvError(err);
}

const db = createSupabaseDb(config.supabaseUrl, config.supabaseKey);

if (stdio) {
  // Local dev only: one conversation for the life of the process.
  const server = buildServer({ db, conversationId: process.env.MCP_CONVERSATION_ID?.trim() || null, turnIndex: null });
  await server.connect(new StdioServerTransport());
  console.error("relaypay-support MCP server running on stdio");
} else {
  const app = createApp({ db, token: config.mcpToken!, readinessCheck: async () => void (await db.customerById("CUS-0000")) });
  app.listen(config.port, () => console.error(`relaypay-support MCP server listening on :${config.port}/mcp`));
}
