import type { ToolContext } from "../context.js";

// Abuse limits (design §5.2). Counted from conversation_events, so they hold across
// requests and server instances. Outputs keep the spec's shape: a limit just means found: false.

export const LIMITS = {
  identityAttemptsPerCall: 3,
  identityAttemptsPerCustomer24h: 5,
  anonymousLookupsPerCall: 5,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const event = (ctx: ToolContext, eventType: string, summary: string, metadata: Record<string, unknown> = {}) =>
  ctx.db.insertEvent({ conversation_id: ctx.conversationId, event_type: eventType, summary, metadata: { turn_index: ctx.turnIndex, ...metadata } });

/** True when this call has used up its identity attempts (logs why, each time it blocks). */
export async function identityAttemptsExhausted(ctx: ToolContext): Promise<boolean> {
  if (!ctx.conversationId) return false;
  const failed = await ctx.db.countEvents(ctx.conversationId, "identity_attempt_failed");
  if (failed < LIMITS.identityAttemptsPerCall) return false;
  await event(ctx, "identity_attempts_exceeded", `Identification closed for this call after ${failed} failed attempts.`);
  return true;
}

/** Records a failed company/ID + email match, against the customer it targeted if one was clear. */
export async function recordFailedAttempt(ctx: ToolContext, targetCustomerId: string | null) {
  await event(ctx, "identity_attempt_failed", "Identifying details didn't match one customer.", targetCustomerId ? { customer_id: targetCustomerId } : {});
}

/** True when a customer has had too many failed attempts against it in 24h, across calls. */
export async function customerLockedOut(ctx: ToolContext, customerId: string): Promise<boolean> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const failed = await ctx.db.countCustomerEvents("identity_attempt_failed", customerId, since);
  if (failed < LIMITS.identityAttemptsPerCustomer24h) return false;
  await event(ctx, "identity_attempts_exceeded", `Identification for this customer is paused after ${failed} failed attempts in 24 hours.`, { customer_id: customerId });
  return true;
}

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
