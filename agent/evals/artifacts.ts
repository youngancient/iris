import type { SupabaseClient } from "@supabase/supabase-js";

// Everything a scenario's checks look at, read back from Supabase after the conversation.

export type Artifacts = {
  spoken: string[]; // Iris's reply per turn, as the caller heard it
  transcript: string;
  toolCalls: { turn_index: number | null; tool_name: string; status: string; input_summary: Record<string, unknown> | null; result_summary: Record<string, unknown> | null }[];
  tickets: { ticket_id: string; summary: string; transaction_id: string | null; customer_id: string | null }[];
  escalations: { escalation_id: string; category: string; user_email: string | null }[];
  turns: { turn_index: number; status: string; answer_type: string | null; retrieval_used: boolean; timings: Record<string, number> | null; cost_usd: number | null }[];
  retrievals: { matched: boolean; top_similarity: number | null }[];
  events: { event_type: string }[];
  identifiedCustomer: string | null;
};

export async function collectArtifacts(supabase: SupabaseClient, conversationId: string, spoken: string[], callerLines: string[]): Promise<Artifacts> {
  const by = <T>(table: string, columns: string, order = "created_at") =>
    supabase.from(table).select(columns).eq("conversation_id", conversationId).order(order).then(({ data, error }) => {
      if (error) throw new Error(`${table}: ${error.message}`);
      return (data ?? []) as T[];
    });

  const [toolCalls, tickets, escalations, turns, retrievals, events, convo] = await Promise.all([
    by<Artifacts["toolCalls"][number]>("tool_calls", "turn_index, tool_name, status, input_summary, result_summary"),
    by<Artifacts["tickets"][number]>("support_tickets", "ticket_id, summary, transaction_id, customer_id"),
    by<Artifacts["escalations"][number]>("escalations", "escalation_id, category, user_email"),
    by<Artifacts["turns"][number]>("conversation_turns", "turn_index, status, answer_type, retrieval_used, timings, cost_usd", "turn_index"),
    by<Artifacts["retrievals"][number]>("retrieval_logs", "matched, top_similarity"),
    by<Artifacts["events"][number]>("conversation_events", "event_type"),
    supabase.from("conversations").select("identified_customer_id").eq("conversation_id", conversationId).maybeSingle(),
  ]);

  // Each Iris line is followed by what the tools actually did that turn, so the judge
  // can check claims ("I've opened a ticket") against the record.
  const actionsFor = (turn: number) =>
    toolCalls
      .filter((t) => t.turn_index === turn)
      .map((t) => {
        const r = t.result_summary ?? {};
        const id = r.ticket_id ?? r.escalation_id ?? (r.found !== undefined ? `found=${r.found}` : "");
        return `${t.tool_name} → ${t.status}${id ? ` (${id})` : ""}`;
      });
  const transcript = callerLines
    .map((line, i) => {
      const actions = actionsFor(i);
      return `Caller: ${line}\nIris: ${spoken[i] ?? ""}${actions.length ? `\n  [tools this turn: ${actions.join("; ")}]` : ""}`;
    })
    .join("\n");
  return {
    spoken, transcript, toolCalls, tickets, escalations, turns, retrievals, events,
    identifiedCustomer: (convo.data?.identified_customer_id as string | null) ?? null,
  };
}
