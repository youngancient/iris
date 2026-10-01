import type { SupabaseClient } from "@supabase/supabase-js";

// End-of-call bookkeeping (design §2 step 7).

export type CallSummary = { tickets: number; escalations: number; turns: number; followUpSeen: boolean; identifiedCustomer: string | null };

export interface CallStore {
  summarize(conversationId: string): Promise<CallSummary>;
  /** Idempotent: ended_at is only set the first time. */
  endCall(
    conversationId: string,
    fields: { summary: string | null; finalStatus: string; callerId: string; costUsd: number | null; durationS: number | null },
  ): Promise<void>;
  event(conversationId: string, eventType: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  hasEvent(conversationId: string, eventType: string): Promise<boolean>;
}

export function createSupabaseCallStore(supabase: SupabaseClient): CallStore {
  const count = async (table: string, conversationId: string, extra?: (q: any) => any) => {
    let q = supabase.from(table).select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
    if (extra) q = extra(q);
    const { count: n, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    return n ?? 0;
  };

  return {
    async summarize(conversationId) {
      const [tickets, escalations, turns, followUps, convo] = await Promise.all([
        count("support_tickets", conversationId),
        count("escalations", conversationId),
        count("conversation_turns", conversationId),
        count("conversation_events", conversationId, (q) => q.eq("event_type", "follow_up_status_seen")),
        supabase.from("conversations").select("identified_customer_id").eq("conversation_id", conversationId).maybeSingle(),
      ]);
      if (convo.error) throw new Error(`conversations: ${convo.error.message}`);
      return { tickets, escalations, turns, followUpSeen: followUps > 0, identifiedCustomer: convo.data?.identified_customer_id ?? null };
    },

    async endCall(conversationId, { summary, finalStatus, callerId, costUsd, durationS }) {
      const { error } = await supabase
        .from("conversations")
        .upsert({ conversation_id: conversationId, channel: "web" }, { onConflict: "conversation_id", ignoreDuplicates: true });
      if (error) throw new Error(`conversations: ${error.message}`);
      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          ended_at: new Date().toISOString(), summary, final_status: finalStatus, caller_id: callerId,
          vapi_cost_usd: costUsd, duration_s: durationS === null ? null : Math.round(durationS),
        })
        .eq("conversation_id", conversationId)
        .is("ended_at", null);
      if (updateError) throw new Error(`conversations: ${updateError.message}`);
    },

    async event(conversationId, eventType, summary, metadata = {}) {
      const { error } = await supabase.from("conversation_events").insert({ conversation_id: conversationId, event_type: eventType, summary, metadata });
      if (error) throw new Error(`conversation_events: ${error.message}`);
    },

    async hasEvent(conversationId, eventType) {
      return (await count("conversation_events", conversationId, (q) => q.eq("event_type", eventType))) > 0;
    },
  };
}

export function finalStatus(s: CallSummary): string {
  if (s.escalations > 0) return "escalated";
  if (s.tickets > 0) return "ticketed";
  if (s.turns > 0) return "resolved";
  return "abandoned";
}
