import type { ToolContext } from "../context.js";

// Abuse guards (design §5.2). There's no limit on identity attempts or signed-out lookups:
// identity comes only from signing in, and records are only returned to their signed-in owner,
// so guessing emails or references can't reveal anything.

const event = (ctx: ToolContext, eventType: string, summary: string, metadata: Record<string, unknown> = {}) =>
  ctx.db.insertEvent({ conversation_id: ctx.conversationId, event_type: eventType, summary, metadata: { turn_index: ctx.turnIndex, ...metadata } });

export async function identitySwitchBlocked(ctx: ToolContext, from: string, to: string) {
  await event(ctx, "identity_switch_blocked", "The caller was already verified as another customer on this call.", { verified_as: from, attempted: to });
}
