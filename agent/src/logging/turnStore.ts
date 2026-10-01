import type { SupabaseClient } from "@supabase/supabase-js";

// Persistence for conversations, turns and events. Behind an interface so the
// turn logic is testable without a database.

export type TurnClaim =
  | { state: "claimed" }
  | { state: "completed"; response: string }
  | { state: "in_progress"; ageMs: number }
  | { state: "failed" };

export type TurnResult = {
  assistantResponse: string;
  answerType: string | null;
  confidenceNote: string;
  retrievalUsed: boolean;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Milliseconds per phase, measured from the start of the request. */
  timings: Record<string, number>;
};

/** What this call has already done, from our own records (never from the model). */
export type PriorActions = {
  identifiedCustomer: string | null;
  tickets: { id: string; turn: number | null }[];
  escalations: { id: string; turn: number | null }[];
};

export interface TurnStore {
  priorActions(conversationId: string): Promise<PriorActions>;
  /**
   * Creates the conversation if needed and claims (conversation, turn) for this
   * request, or reports what an earlier attempt left. One round-trip (migration 004).
   */
  claimTurn(conversationId: string, channel: string, turnIndex: number, userTranscript: string): Promise<TurnClaim>;
  /** Writes only if the turn still holds this transcript: a newer attempt may have taken it over (migration 011). */
  /** Resolves false when a newer attempt took the turn over, so the caller skips its events. */
  completeTurn(conversationId: string, turnIndex: number, result: TurnResult, transcript: string): Promise<boolean>;
  failTurn(conversationId: string, turnIndex: number, error: string, result: Partial<TurnResult>, transcript: string): Promise<boolean>;
  event(conversationId: string, eventType: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Tool calls the MCP SDK rejected before our server code ran (e.g. a missing required field). */
  toolCallRejected(conversationId: string, turnIndex: number, tool: string, error: string): Promise<void>;
}

const turnRow = (r: Partial<TurnResult>) => ({
  assistant_response: r.assistantResponse,
  answer_type: r.answerType,
  confidence_note: r.confidenceNote,
  retrieval_used: r.retrievalUsed,
  latency_ms: r.latencyMs,
  cost_usd: r.costUsd,
  model: r.model,
  prompt_version: r.promptVersion,
  input_tokens: r.inputTokens,
  output_tokens: r.outputTokens,
  cache_read_tokens: r.cacheReadTokens,
  timings: r.timings,
  updated_at: new Date().toISOString(),
});

export function createSupabaseTurnStore(supabase: SupabaseClient): TurnStore {
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  return {
    async claimTurn(conversationId, channel, turnIndex, userTranscript) {
      const { data, error } = await supabase.rpc("claim_turn", {
        p_conversation_id: conversationId,
        p_channel: channel,
        p_turn_index: turnIndex,
        p_transcript: userTranscript,
      });
      check(error, "claimTurn");
      const row = (data as { state: string; response: string | null; age_ms: number }[])[0];
      if (!row) throw new Error("claimTurn: no result");
      if (row.state === "claimed") return { state: "claimed" };
      if (row.state === "completed") return { state: "completed", response: row.response ?? "" };
      if (row.state === "in_progress") return { state: "in_progress", ageMs: Number(row.age_ms) };
      return { state: "failed" };
    },

    async priorActions(conversationId) {
      const [convo, calls] = await Promise.all([
        supabase.from("conversations").select("identified_customer_id").eq("conversation_id", conversationId).maybeSingle(),
        supabase
          .from("tool_calls")
          .select("tool_name, turn_index, result_summary")
          .eq("conversation_id", conversationId)
          .eq("status", "success")
          .in("tool_name", ["create_support_ticket", "create_escalation"])
          .order("created_at"),
      ]);
      check(convo.error, "priorActions");
      check(calls.error, "priorActions");
      const seen = new Set<string>();
      const actions: PriorActions = { identifiedCustomer: convo.data?.identified_customer_id ?? null, tickets: [], escalations: [] };
      for (const c of calls.data ?? []) {
        const summary = (c.result_summary ?? {}) as Record<string, unknown>;
        const id = String(summary.ticket_id ?? summary.escalation_id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        (c.tool_name === "create_support_ticket" ? actions.tickets : actions.escalations).push({ id, turn: c.turn_index });
      }
      return actions;
    },

    async completeTurn(conversationId, turnIndex, result, transcript) {
      const { data, error } = await supabase
        .from("conversation_turns")
        .update({ ...turnRow(result), status: "completed", error_message: null })
        .eq("conversation_id", conversationId)
        .eq("turn_index", turnIndex)
        .eq("user_transcript", transcript)
        .select("id");
      check(error, "completeTurn");
      return (data ?? []).length > 0;
    },

    async failTurn(conversationId, turnIndex, message, result, transcript) {
      const { data, error } = await supabase
        .from("conversation_turns")
        .update({ ...turnRow(result), status: "failed", error_message: message })
        .eq("conversation_id", conversationId)
        .eq("turn_index", turnIndex)
        .eq("user_transcript", transcript)
        .select("id");
      check(error, "failTurn");
      return (data ?? []).length > 0;
    },

    async event(conversationId, eventType, summary, metadata = {}) {
      const { error } = await supabase
        .from("conversation_events")
        .insert({ conversation_id: conversationId, event_type: eventType, summary, metadata });
      check(error, "event");
    },

    async toolCallRejected(conversationId, turnIndex, tool, message) {
      const { error } = await supabase.from("tool_calls").insert({
        conversation_id: conversationId,
        turn_index: turnIndex,
        tool_name: tool.replace(/^mcp__relaypay__/, ""),
        purpose: "rejected by MCP input validation before the tool ran",
        status: "error",
        error_message: message.slice(0, 500),
        duration_ms: 0,
      });
      check(error, "toolCallRejected");
    },
  };
}
