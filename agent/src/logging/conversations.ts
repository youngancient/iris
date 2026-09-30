import { supabase } from "../supabase.js";

export type AnswerType = "answer" | "clarify" | "escalate" | "decline";

export async function startConversation(conversationId: string, channel: "web" | "phone" | "eval") {
  const { error } = await supabase
    .from("conversations")
    .upsert({ conversation_id: conversationId, channel }, { onConflict: "conversation_id", ignoreDuplicates: true });
  if (error) console.error("startConversation:", error.message);
}

export async function endConversation(conversationId: string, summary: string | null) {
  // TODO: derive final_status from tickets/escalations created in this conversation
  const { error } = await supabase
    .from("conversations")
    .update({ ended_at: new Date().toISOString(), summary })
    .eq("conversation_id", conversationId);
  if (error) console.error("endConversation:", error.message);
}

export async function logTurn(turn: {
  conversationId: string;
  userTranscript: string;
  assistantResponse: string;
  answerType: AnswerType | null;
  confidenceNote?: string;
}) {
  const { error } = await supabase.from("conversation_turns").insert({
    conversation_id: turn.conversationId,
    user_transcript: turn.userTranscript,
    assistant_response: turn.assistantResponse,
    answer_type: turn.answerType,
    confidence_note: turn.confidenceNote ?? null,
  });
  if (error) console.error("logTurn:", error.message);
}
