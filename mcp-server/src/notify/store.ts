import type { SupabaseClient } from "@supabase/supabase-js";

// What the notifier reads and writes. Behind an interface so the loop is testable.

export type PendingEscalation = {
  escalation_id: string; conversation_id: string | null; ticket_id: string | null; customer_id: string | null;
  user_name: string | null; user_email: string | null; category: string; reason: string; preferred_time: string | null;
  created_at: string; notified_at: string | null; emailed_at: string | null; undelivered_alerted_at: string | null;
};
export type Failure = { created_at: string; kind: string; conversation_id: string | null; source: string; detail: string | null };
export type KillSwitchChange = { created_at: string; admin_email: string; action: string; reason: string | null };

export interface NotifyStore {
  pendingEscalations(limit: number): Promise<PendingEscalation[]>;
  escalation(id: string): Promise<PendingEscalation | null>;
  markNotified(id: string): Promise<void>;
  markEmailed(id: string): Promise<void>;
  bumpAttempt(id: string, channel: "discord" | "email"): Promise<void>;
  markUndeliveredAlerted(id: string): Promise<void>;
  cursor(): Promise<{ lastFailureAt: string | null; lastAdminActionAt: string | null }>;
  setCursor(fields: { lastFailureAt?: string; lastAdminActionAt?: string }): Promise<void>;
  failuresSince(iso: string, limit: number): Promise<Failure[]>;
  killSwitchChangesSince(iso: string, limit: number): Promise<KillSwitchChange[]>;
  recordEvent(conversationId: string | null, eventType: string, summary: string, metadata: Record<string, unknown>): Promise<void>;
}

const ESC_COLS =
  "escalation_id, conversation_id, ticket_id, customer_id, user_name, user_email, category, reason, preferred_time, created_at, notified_at, emailed_at, undelivered_alerted_at";

export function createSupabaseNotifyStore(db: SupabaseClient): NotifyStore {
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async pendingEscalations(limit) {
      const { data, error } = await db
        .from("escalations")
        .select(ESC_COLS)
        .or("notified_at.is.null,emailed_at.is.null")
        // Test conversations never notify the team.
        .or("conversation_id.is.null,conversation_id.not.like.eval-*")
        .order("created_at")
        .limit(limit);
      check(error, "pendingEscalations");
      return (data ?? []) as PendingEscalation[];
    },
    async escalation(id) {
      const { data, error } = await db.from("escalations").select(ESC_COLS).eq("escalation_id", id).maybeSingle();
      check(error, "escalation");
      return data as PendingEscalation | null;
    },
    async markNotified(id) {
      const { error } = await db.from("escalations").update({ notified_at: new Date().toISOString() }).eq("escalation_id", id).is("notified_at", null);
      check(error, "markNotified");
    },
    async markEmailed(id) {
      const { error } = await db.from("escalations").update({ emailed_at: new Date().toISOString() }).eq("escalation_id", id).is("emailed_at", null);
      check(error, "markEmailed");
    },
    async bumpAttempt(id, channel) {
      const column = channel === "discord" ? "notify_attempts" : "email_attempts";
      const { data, error } = await db.from("escalations").select(column).eq("escalation_id", id).maybeSingle();
      check(error, "bumpAttempt");
      const current = Number((data as Record<string, number> | null)?.[column] ?? 0);
      const { error: updateError } = await db.from("escalations").update({ [column]: current + 1 }).eq("escalation_id", id);
      check(updateError, "bumpAttempt");
    },
    async markUndeliveredAlerted(id) {
      const { error } = await db.from("escalations").update({ undelivered_alerted_at: new Date().toISOString() }).eq("escalation_id", id);
      check(error, "markUndeliveredAlerted");
    },
    async cursor() {
      const { data, error } = await db.from("alert_cursor").select("last_failure_at, last_admin_action_at").eq("id", true).maybeSingle();
      check(error, "cursor");
      return { lastFailureAt: data?.last_failure_at ?? null, lastAdminActionAt: data?.last_admin_action_at ?? null };
    },
    async setCursor({ lastFailureAt, lastAdminActionAt }) {
      const fields: Record<string, string> = { updated_at: new Date().toISOString() };
      if (lastFailureAt) fields.last_failure_at = lastFailureAt;
      if (lastAdminActionAt) fields.last_admin_action_at = lastAdminActionAt;
      const { error } = await db.from("alert_cursor").update(fields).eq("id", true);
      check(error, "setCursor");
    },
    async failuresSince(iso, limit) {
      const { data, error } = await db
        .from("v_failures")
        .select("created_at, kind, conversation_id, source, detail")
        .gt("created_at", iso)
        .or("conversation_id.is.null,conversation_id.not.like.eval-*")
        .order("created_at")
        .limit(limit);
      check(error, "failuresSince");
      return (data ?? []) as Failure[];
    },
    async killSwitchChangesSince(iso, limit) {
      const { data, error } = await db
        .from("admin_actions")
        .select("created_at, admin_email, action, reason")
        .in("action", ["kill_switch_on", "kill_switch_off"])
        .gt("created_at", iso)
        .order("created_at")
        .limit(limit);
      check(error, "killSwitchChangesSince");
      return (data ?? []) as KillSwitchChange[];
    },
    async recordEvent(conversationId, eventType, summary, metadata) {
      const { error } = await db.from("conversation_events").insert({ conversation_id: conversationId, event_type: eventType, summary, metadata });
      check(error, "recordEvent");
    },
  };
}
