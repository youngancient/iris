import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { EMAIL_PATTERN, normalizeEmail, normalizeEscalationCategory, present } from "../lib/normalize.js";
import { withToolLogging } from "../lib/withToolLogging.js";

const description =
  "Use this tool when the request requires human support: compliance, disputes, account restrictions, refunds, " +
  "cancellations, frustrated customers, or records in review. Collect the caller's name and email first (read the " +
  "email back to confirm it), plus a preferred callback time if they have one. Pass ticket_id if a ticket was " +
  "created for this issue. Read follow_up_summary to the caller. Calling again for the same issue returns the same escalation.";

const inputSchema = {
  ticket_id: z.string().optional(),
  customer_id: z.string().optional(),
  user_name: z.string(),
  user_email: z.string(),
  category: z.string(),
  reason: z.string(),
  preferred_time: z.string().optional(),
};

const outputSchema = { escalation_id: z.string(), status: z.string(), follow_up_summary: z.string() };

// Fixed wording: no timeline promises (knowledge base: avoid guarantees).
const followUpSummary = (preferredTime: string | undefined) =>
  preferredTime
    ? `A RelayPay specialist will contact you at the email you provided, around ${preferredTime}.`
    : "A RelayPay specialist will contact you at the email you provided.";

type Input = {
  ticket_id?: string; customer_id?: string; user_name: string; user_email: string;
  category: string; reason: string; preferred_time?: string;
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "create_escalation",
    { description, inputSchema, outputSchema },
    withToolLogging(
      ctx,
      { name: "create_escalation", purpose: description, failureMessage: "The escalation couldn't be saved right now. Don't tell the caller a specialist will follow up." },
      async (input: Input) => {
        const missing = (["user_name", "user_email", "category", "reason"] as const).filter((f) => !present(input[f]));
        if (missing.length > 0) {
          return { status: "invalid", message: `Missing ${missing.join(", ")}. Ask the caller for it before escalating.` };
        }
        const email = normalizeEmail(input.user_email);
        if (!EMAIL_PATTERN.test(email)) {
          return { status: "invalid", message: "user_email doesn't look like a valid email. Ask the caller to spell it again." };
        }

        const conversationId = ctx.conversationId;
        const category = normalizeEscalationCategory(input.category);
        const preferredTime = present(input.preferred_time);
        // Same trust rule as tickets: only the identified customer is linked.
        const customerId = conversationId ? await ctx.db.identifiedCustomer(conversationId) : null;
        const ticketRef = present(input.ticket_id)?.toUpperCase();
        const ticketId = ticketRef && (await ctx.db.ticketExists(ticketRef)) ? ticketRef : null;

        const escalation = await ctx.db.insertEscalation({
          conversation_id: conversationId,
          ticket_id: ticketId,
          customer_id: customerId,
          user_name: input.user_name.trim(),
          user_email: email,
          category,
          reason: input.reason.trim(),
          call_booked: Boolean(preferredTime),
          preferred_time: preferredTime ?? null,
        });

        // Written by the server itself, so it never depends on the model calling log_conversation_event.
        if (escalation.created) {
          await ctx.db.insertEvent({
            conversation_id: conversationId,
            event_type: "escalation_created",
            summary: `Escalated (${category}): ${input.reason.trim()}`,
            metadata: { escalation_id: escalation.escalation_id, ticket_id: ticketId, call_booked: Boolean(preferredTime) },
          });
        }

        return {
          status: "success",
          data: {
            escalation_id: escalation.escalation_id,
            status: escalation.status,
            follow_up_summary: followUpSummary(preferredTime),
          },
        };
      },
    ),
  );
}
