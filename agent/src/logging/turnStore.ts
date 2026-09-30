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
};

export interface TurnStore {
  ensureConversation(conversationId: string, channel: string): Promise<void>;
  /** Claims (conversation, turn) for this request, or reports what an earlier attempt left. */
  claimTurn(conversationId: string, turnIndex: number, userTranscript: string): Promise<TurnClaim>;
  completeTurn(conversationId: string, turnIndex: number, result: TurnResult): Promise<void>;
  failTurn(conversationId: string, turnIndex: number, error: string, result: Partial<TurnResult>): Promise<void>;
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
  updated_at: new Date().toISOString(),
});

export function createSupabaseTurnStore(supabase: SupabaseClient): TurnStore {
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  return {
    async ensureConversation(conversationId, channel) {
      const { error } = await supabase
        .from("conversations")
        .upsert({ conversation_id: conversationId, channel, caller_id: conversationId }, { onConflict: "conversation_id", ignoreDuplicates: true });
      check(error, "ensureConversation");
    },

    async claimTurn(conversationId, turnIndex, userTranscript) {
      const { error } = await supabase
        .from("conversation_turns")
        .insert({ conversation_id: conversationId, turn_index: turnIndex, user_transcript: userTranscript, status: "in_progress" });
      if (!error) return { state: "claimed" };
      if (error.code !== "23505") check(error, "claimTurn");

      const { data, error: readError } = await supabase
        .from("conversation_turns")
        .select("status, assistant_response, updated_at")
        .eq("conversation_id", conversationId)
        .eq("turn_index", turnIndex)
        .single();
      check(readError, "claimTurn");
      if (!data) throw new Error("claimTurn: turn row vanished after a conflict");
      if (data.status === "completed") return { state: "completed", response: data.assistant_response ?? "" };
      if (data.status === "in_progress") return { state: "in_progress", ageMs: Date.now() - Date.parse(data.updated_at) };
      return { state: "failed" };
    },

    async completeTurn(conversationId, turnIndex, result) {
      const { error } = await supabase
        .from("conversation_turns")
        .update({ ...turnRow(result), status: "completed", error_message: null })
        .eq("conversation_id", conversationId)
        .eq("turn_index", turnIndex);
      check(error, "completeTurn");
    },

    async failTurn(conversationId, turnIndex, message, result) {
      const { error } = await supabase
        .from("conversation_turns")
        .update({ ...turnRow(result), status: "failed", error_message: message })
        .eq("conversation_id", conversationId)
        .eq("turn_index", turnIndex);
      check(error, "failTurn");
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
