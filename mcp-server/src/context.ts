import type { Db } from "./db/types.js";
import { log } from "./logger.js";

/**
 * Per-request context. conversationId comes from the X-Conversation-Id header
 * the agent sets, never from the model (design §5.1).
 */
export type ToolContext = {
  db: Db;
  conversationId: string | null;
  turnIndex: number | null;
  /** Per-tool deadline override (tests); defaults to TOOL_DEADLINE_MS. */
  deadlineMs?: number;
  /** Tells the notifier straight away; never awaited, so it can't slow or fail the tool. */
  onEscalationCreated?: (escalationId: string) => void;
  /** Same for tickets. Called for every successful create; already-delivered tickets are skipped. */
  onTicketCreated?: (ticketId: string) => void;
  /** A record couldn't be written (the database is failing): alert outside the database. */
  onRecordFailed?: (tool: string, err: unknown) => void;
};

/**
 * For the two tools whose spec input includes conversation_id: the header wins.
 * A different value from the model is logged as a warning and ignored.
 */
export async function resolveConversationId(ctx: ToolContext, fromInput: string | undefined): Promise<string | null> {
  const given = fromInput?.trim() || null;
  if (!ctx.conversationId) return given;
  if (given && given !== ctx.conversationId) {
    await ctx.db
      .insertEvent({
        conversation_id: ctx.conversationId,
        event_type: "conversation_id_mismatch",
        summary: "Tool input conversation_id differed from the request header; the header value was used.",
        metadata: { input_conversation_id: given },
      })
      .catch((err) => log.error({ err }, "event log failed"));
  }
  return ctx.conversationId;
}
