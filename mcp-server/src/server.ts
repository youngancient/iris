import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import * as createEscalation from "./tools/createEscalation.js";
import * as createSupportTicket from "./tools/createSupportTicket.js";
import * as logConversationEvent from "./tools/logConversationEvent.js";
import * as lookupCustomer from "./tools/lookupCustomer.js";
import * as lookupPayout from "./tools/lookupPayout.js";
import * as lookupTransaction from "./tools/lookupTransaction.js";

export const TOOLS = [
  lookupCustomer,
  lookupTransaction,
  lookupPayout,
  createSupportTicket,
  createEscalation,
  logConversationEvent,
];

/** A fresh server per request, bound to that request's conversation (stateless HTTP mode). */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "relaypay-support", version: "0.1.0" });
  for (const tool of TOOLS) tool.register(server, ctx);
  return server;
}
