#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as lookupCustomer from "./tools/lookupCustomer.js";
import * as lookupTransaction from "./tools/lookupTransaction.js";
import * as lookupPayout from "./tools/lookupPayout.js";
import * as createSupportTicket from "./tools/createSupportTicket.js";
import * as createEscalation from "./tools/createEscalation.js";
import * as logConversationEvent from "./tools/logConversationEvent.js";

const server = new McpServer({ name: "relaypay-support", version: "0.1.0" });

for (const tool of [
  lookupCustomer,
  lookupTransaction,
  lookupPayout,
  createSupportTicket,
  createEscalation,
  logConversationEvent,
]) {
  tool.register(server);
}

await server.connect(new StdioServerTransport());
console.error("relaypay-support MCP server running on stdio");
