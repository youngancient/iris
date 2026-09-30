import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveConversationId, type ToolContext } from "../context.js";
import { normalizePriority, normalizeRef, normalizeTicketCategory, present } from "../lib/normalize.js";
import { withToolLogging } from "../lib/withToolLogging.js";

const description =
  "Use this tool when the agent needs to log an issue for support follow-up. Include any transaction reference " +
  "the caller gave (e.g. TXN-9001) in summary, even if the lookup found nothing. " +
  "category examples: payment, payout, invoice, account, compliance, dispute, refund, onboarding, fees, other. " +
  "priority: low, medium, high or urgent. Calling again for the same issue returns the same ticket.";

const inputSchema = {
  customer_id: z.string().optional(),
  category: z.string(),
  priority: z.string(),
  summary: z.string(),
  conversation_id: z.string(),
};

const outputSchema = { ticket_id: z.string(), status: z.string() };

const RECENT_WINDOW_MS = 10 * 60 * 1000;
const TXN_REF = /\bTXN[-\s]?(\d+)\b/i;

const sha256 = (parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "create_support_ticket",
    { description, inputSchema, outputSchema },
    withToolLogging(
      ctx,
      { name: "create_support_ticket", purpose: description, failureMessage: "The ticket couldn't be saved right now. Don't tell the caller it was created." },
      async (input: { customer_id?: string; category: string; priority: string; summary: string; conversation_id: string }) => {
        const summary = present(input.summary);
        if (!summary) return { status: "invalid", message: "summary is required: describe the issue in one or two sentences." };

        const conversationId = await resolveConversationId(ctx, input.conversation_id);
        const category = normalizeTicketCategory(input.category);
        const priority = normalizePriority(input.priority);

        // The customer on a ticket is only ever the one identified on this call (trust-critical, design §4.4).
        const identified = conversationId ? await ctx.db.identifiedCustomer(conversationId) : null;
        const claimed = present(input.customer_id) && normalizeRef(input.customer_id!, "CUS");
        const customerId = identified;
        const storedSummary =
          claimed && claimed !== identified ? `${summary} (Caller-provided customer ID ${claimed}, not verified.)` : summary;

        // Link the ticket to a transaction mentioned in the summary, if it exists and isn't someone else's.
        const refMatch = TXN_REF.exec(summary);
        const txnRef = refMatch ? `TXN-${refMatch[1]}` : null;
        let transactionId: string | null = null;
        if (txnRef) {
          const txn = await ctx.db.transactionById(txnRef);
          if (txn && (!identified || txn.customer_id === identified)) transactionId = txn.transaction_id;
        }

        let ticket: { ticket_id: string; status: string };
        let idempotencyKey: string | undefined;
        if (txnRef && conversationId) {
          idempotencyKey = sha256([conversationId, category, customerId ?? "", txnRef]);
          ticket = await ctx.db.insertTicket({
            conversation_id: conversationId, customer_id: customerId, transaction_id: transactionId,
            category, priority, summary: storedSummary, idempotency_key: idempotencyKey,
          });
        } else {
          // No reference to key on: a reworded retry within 10 minutes returns the same ticket.
          const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
          const recent = conversationId ? await ctx.db.recentTicket(conversationId, category, customerId, since) : null;
          ticket =
            recent ??
            (await ctx.db.insertTicket({
              conversation_id: conversationId, customer_id: customerId, transaction_id: transactionId,
              category, priority, summary: storedSummary, idempotency_key: null,
            }));
        }

        return { status: "success", data: { ticket_id: ticket.ticket_id, status: ticket.status }, idempotencyKey };
      },
    ),
  );
}
