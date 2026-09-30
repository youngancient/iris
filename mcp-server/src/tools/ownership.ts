import type { ToolContext } from "../context.js";

export type Access = "owner" | "anonymous" | "other_customer";

/**
 * How much of a record the caller may see (design §5.2):
 * - owner: identified as the record's customer → everything
 * - anonymous: not identified → status and summary, no amount or customer_id
 * - other_customer: identified as someone else → treated as not found
 */
export async function accessFor(ctx: ToolContext, recordCustomerId: string | null): Promise<Access> {
  const identified = ctx.conversationId ? await ctx.db.identifiedCustomer(ctx.conversationId) : null;
  if (!identified) return "anonymous";
  return identified === recordCustomerId ? "owner" : "other_customer";
}
