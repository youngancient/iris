import type { ToolContext } from "../context.js";

export type Access = "owner" | "anonymous" | "other_customer";

/**
 * How much of a record the caller may see (design §5.2):
 * - owner: identified as the record's customer → everything
 * - anonymous: not identified → status and summary, no amount or customer_id
 * - other_customer: identified as someone else → treated as not found
 */
export function accessFrom(identified: string | null, recordCustomerId: string | null): Access {
  if (!identified) return "anonymous";
  return identified === recordCustomerId ? "owner" : "other_customer";
}

/**
 * Whether this request may see a record owned by recordCustomerId: only its signed-in owner, or a
 * local stdio operator. Everyone else (signed out, or signed in as someone else) gets not found.
 */
export function maySee(ctx: ToolContext, identified: string | null, recordCustomerId: string | null): boolean {
  return ctx.operator === true || accessFrom(identified, recordCustomerId) === "owner";
}

/** Who this call is identified as. Start it alongside the record read, not after it. */
export function identifiedFor(ctx: ToolContext): Promise<string | null> {
  return ctx.conversationId ? ctx.db.identifiedCustomer(ctx.conversationId) : Promise.resolve(null);
}
