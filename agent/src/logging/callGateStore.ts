import type { SupabaseClient } from "@supabase/supabase-js";

// Records which calls proved they were started from our web page (design §8).
export interface CallGateStore {
  isVerified(conversationId: string): Promise<boolean>;
  /**
   * Claims a token's nonce for this call, and records the signed-in customer (if any) as the
   * call's identity (design §5.2). False if another call already used the nonce.
   */
  claimNonce(conversationId: string, nonce: string, customerId: string | null): Promise<boolean>;
  event(conversationId: string, eventType: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Total model spend recorded on this call so far. */
  spentSoFar(conversationId: string): Promise<number>;
}

export function createSupabaseCallGateStore(supabase: SupabaseClient): CallGateStore {
  return {
    async isVerified(conversationId) {
      const { data, error } = await supabase.from("conversations").select("call_verified").eq("conversation_id", conversationId).maybeSingle();
      if (error) throw new Error(`isVerified: ${error.message}`);
      return Boolean(data?.call_verified);
    },
    async claimNonce(conversationId, nonce, customerId) {
      const { error: upsertError } = await supabase
        .from("conversations")
        .upsert({ conversation_id: conversationId, channel: "web", caller_id: conversationId }, { onConflict: "conversation_id", ignoreDuplicates: true });
      if (upsertError) throw new Error(`claimNonce: ${upsertError.message}`);
      const { error } = await supabase
        .from("conversations")
        .update({ call_token_nonce: nonce, call_verified: true, ...(customerId ? { identified_customer_id: customerId } : {}) })
        .eq("conversation_id", conversationId);
      if (!error) return true;
      if (error.code === "23505") return false; // nonce already used by another call
      throw new Error(`claimNonce: ${error.message}`);
    },
    async event(conversationId, eventType, summary, metadata = {}) {
      const { error } = await supabase.from("conversation_events").insert({ conversation_id: conversationId, event_type: eventType, summary, metadata });
      if (error) throw new Error(`event: ${error.message}`);
    },
    async spentSoFar(conversationId) {
      const { data, error } = await supabase.from("conversation_turns").select("cost_usd").eq("conversation_id", conversationId).limit(500);
      if (error) throw new Error(`spentSoFar: ${error.message}`);
      return (data ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    },
  };
}
