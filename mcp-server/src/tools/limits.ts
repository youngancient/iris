import type { ToolContext } from "../context.js";

// Abuse limits (design §5.2). Counted from conversation_events, so they hold across
// requests and server instances. Outputs keep the spec's shape: a limit just means found: false.
// There's no limit on identity attempts: since identity comes only from signing in, a caller
// guessing emails can't unlock anything.

export const LIMITS = {
  anonymousLookupsPerCall: 5,
};

const event = (ctx: ToolContext, eventType: string, summary: string, metadata: Record<string, unknown> = {}) =>
  ctx.db.insertEvent({ conversation_id: ctx.conversationId, event_type: eventType, summary, metadata: { turn_index: ctx.turnIndex, ...metadata } });




export async function identitySwitchBlocked(ctx: ToolContext, from: string, to: string) {
  await event(ctx, "identity_switch_blocked", "The caller was already verified as another customer on this call.", { verified_as: from, attempted: to });
}

/**
 * Unverified callers get a limited number of transaction/payout lookups per call.
 * Returns true if this lookup is over the limit; otherwise counts it.
 */
export async function anonymousLookupOverLimit(ctx: ToolContext): Promise<boolean> {
  if (!ctx.conversationId) return false;
  const used = await ctx.db.countEvents(ctx.conversationId, "anonymous_lookup");
  if (used >= LIMITS.anonymousLookupsPerCall) {
    await event(ctx, "lookup_rate_limited", `Lookup refused: ${used} lookups already made without verification on this call.`);
    return true;
  }
  await event(ctx, "anonymous_lookup", "Lookup by an unverified caller.");
  return false;
}
