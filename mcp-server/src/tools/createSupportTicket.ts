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
      { name: "create_support_ticket", purpose: description, failureMessage: "The ticket couldn't be saved right now. Don't tell the caller it was created.", retrySafe: true },
      async (input: { customer_id?: string; category: string; priority: string; summary: string; conversation_id: string }) => {
        const summary = present(input.summary);
        if (!summary) return { status: "invalid", message: "summary is required: describe the issue in one or two sentences." };

        const conversationId = await resolveConversationId(ctx, input.conversation_id);
        const category = normalizeTicketCategory(input.category);
        const priority = normalizePriority(input.priority);

        const refMatch = TXN_REF.exec(summary);
        const txnRef = refMatch ? `TXN-${refMatch[1]}` : null;
        // Independent reads, so they run together.
        const [identified, txn] = await Promise.all([
          // The customer on a ticket is only ever the one identified on this call (trust-critical, design §4.4).
          conversationId ? ctx.db.identifiedCustomer(conversationId) : Promise.resolve(null),
          txnRef ? ctx.db.transactionById(txnRef) : Promise.resolve(null),
        ]);
        const claimed = present(input.customer_id) && normalizeRef(input.customer_id!, "CUS");
        const customerId = identified;
        const storedSummary =
          claimed && claimed !== identified ? `${summary} (Caller-provided customer ID ${claimed}, not verified.)` : summary;

        // Link the ticket to a transaction mentioned in the summary, if it exists and isn't someone else's.
        const transactionId = txn && (!identified || txn.customer_id === identified) ? txn.transaction_id : null;

        // One open ticket per issue per call: a later call within 10 minutes (a retry, a
        // rewording, or the same issue with a reference added) returns the same ticket,
        // with any new reference appended, instead of creating a second one.
        const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
        const recent = conversationId ? await ctx.db.recentTicket(conversationId, category, customerId, since) : null;
        let ticket: { ticket_id: string; status: string };
        let idempotencyKey: string | undefined;
        if (recent) {
          const newRef = txnRef && !new RegExp(txnRef, "i").test(recent.summary);
          if (newRef || (transactionId && !recent.transaction_id)) {
            await ctx.db.updateTicket(recent.ticket_id, {
              summary: newRef ? `${recent.summary} Update: ${storedSummary}` : recent.summary,
              transaction_id: recent.transaction_id ?? transactionId,
            });
          }
          ticket = recent;
        } else if (txnRef && conversationId) {
          // Keyed on the reference too, so a retry after the 10-minute window still can't duplicate it.
          idempotencyKey = sha256([conversationId, category, customerId ?? "", txnRef]);
          ticket = await ctx.db.insertTicket({
            conversation_id: conversationId, customer_id: customerId, transaction_id: transactionId,
            category, priority, summary: storedSummary, idempotency_key: idempotencyKey,
          });
        } else {
          ticket = await ctx.db.insertTicket({
            conversation_id: conversationId, customer_id: customerId, transaction_id: transactionId,
            category, priority, summary: storedSummary, idempotency_key: null,
          });
        }

        ctx.onTicketCreated?.(ticket.ticket_id);
        return { status: "success", data: { ticket_id: ticket.ticket_id, status: ticket.status }, idempotencyKey };
      },
    ),
  );
}
