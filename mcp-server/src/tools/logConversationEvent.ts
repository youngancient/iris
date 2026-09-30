import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveConversationId, type ToolContext } from "../context.js";
import { present } from "../lib/normalize.js";
import { withToolLogging } from "../lib/withToolLogging.js";

const description =
  "Use this tool to log important agent actions and decisions. Recommended event_type values: " +
  "clarification_requested, declined, escalation_triggered, lookup_not_found, identity_check_failed, " +
  "caller_frustrated, handoff_requested. Escalations are logged automatically; no need to log them here.";

const inputSchema = {
  conversation_id: z.string(),
  event_type: z.string(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()),
};

const outputSchema = { logged: z.boolean() };

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "log_conversation_event",
    { description, inputSchema, outputSchema },
    withToolLogging(
      ctx,
      { name: "log_conversation_event", purpose: description, failureMessage: "The event couldn't be logged right now." },
      async (input: { conversation_id: string; event_type: string; summary: string; metadata: Record<string, unknown> }) => {
        const eventType = present(input.event_type);
        if (!eventType) return { status: "invalid", message: "event_type is required." };
        await ctx.db.insertEvent({
          conversation_id: await resolveConversationId(ctx, input.conversation_id),
          event_type: eventType.toLowerCase().replace(/\s+/g, "_"),
          summary: present(input.summary) ?? null,
          metadata: input.metadata ?? {},
        });
        return { status: "success", data: { logged: true } };
      },
    ),
  );
}
