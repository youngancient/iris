import type { SupabaseClient } from "@supabase/supabase-js";

// What the notifier reads and writes. Behind an interface so the loop is testable.

export type PendingEscalation = {
  escalation_id: string; conversation_id: string | null; ticket_id: string | null; customer_id: string | null;
  user_name: string | null; user_email: string | null; category: string; reason: string; preferred_time: string | null;
  created_at: string; notified_at: string | null; emailed_at: string | null; undelivered_alerted_at: string | null;
};
export type PendingTicket = {
  ticket_id: string; conversation_id: string | null; customer_id: string | null; transaction_id: string | null;
  category: string; priority: string; summary: string;
  created_at: string; notified_at: string | null; emailed_at: string | null; undelivered_alerted_at: string | null;
};
export type Failure = { created_at: string; kind: string; conversation_id: string | null; source: string; detail: string | null };
export type KillSwitchChange = { created_at: string; admin_email: string; action: string; reason: string | null };

/** Records the team is told about: each is posted to Discord and emailed, each at most once. */
export type NoticeKind = "escalation" | "ticket";

export interface NotifyStore {
  pendingEscalations(limit: number): Promise<PendingEscalation[]>;
  escalation(id: string): Promise<PendingEscalation | null>;
  pendingTickets(limit: number): Promise<PendingTicket[]>;
  ticket(id: string): Promise<PendingTicket | null>;
  markNotified(kind: NoticeKind, id: string): Promise<void>;
  markEmailed(kind: NoticeKind, id: string): Promise<void>;
  bumpAttempt(kind: NoticeKind, id: string, channel: "discord" | "email"): Promise<void>;
  markUndeliveredAlerted(kind: NoticeKind, id: string): Promise<void>;
  cursor(): Promise<{ lastFailureAt: string | null; lastAdminActionAt: string | null }>;
  setCursor(fields: { lastFailureAt?: string; lastAdminActionAt?: string }): Promise<void>;
  failuresSince(iso: string, limit: number): Promise<Failure[]>;
  killSwitchChangesSince(iso: string, limit: number): Promise<KillSwitchChange[]>;
  recordEvent(conversationId: string | null, eventType: string, summary: string, metadata: Record<string, unknown>): Promise<void>;
}

const ESC_COLS =
  "escalation_id, conversation_id, ticket_id, customer_id, user_name, user_email, category, reason, preferred_time, created_at, notified_at, emailed_at, undelivered_alerted_at";
const TICKET_COLS =
  "ticket_id, conversation_id, customer_id, transaction_id, category, priority, summary, created_at, notified_at, emailed_at, undelivered_alerted_at";

const TABLE: Record<NoticeKind, { table: string; key: string }> = {
  escalation: { table: "escalations", key: "escalation_id" },
  ticket: { table: "support_tickets", key: "ticket_id" },
};

export function createSupabaseNotifyStore(db: SupabaseClient): NotifyStore {
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  async function pending<T>(kind: NoticeKind, cols: string, limit: number): Promise<T[]> {
    const { data, error } = await db
      .from(TABLE[kind].table)
      .select(cols)
      .or("notified_at.is.null,emailed_at.is.null")
      // Test conversations never notify the team.
      .or("conversation_id.is.null,conversation_id.not.like.eval-*")
      .order("created_at")
      .limit(limit);
    check(error, `pending ${kind}s`);
    return (data ?? []) as T[];
  }
  async function one<T>(kind: NoticeKind, cols: string, id: string): Promise<T | null> {
    const { data, error } = await db.from(TABLE[kind].table).select(cols).eq(TABLE[kind].key, id).maybeSingle();
    check(error, kind);
    return data as T | null;
  }
  async function stamp(kind: NoticeKind, id: string, column: string) {
    const { table, key } = TABLE[kind];
    const { error } = await db.from(table).update({ [column]: new Date().toISOString() }).eq(key, id).is(column, null);
    check(error, `mark ${column}`);
  }
  return {
    pendingEscalations: (limit) => pending<PendingEscalation>("escalation", ESC_COLS, limit),
    escalation: (id) => one<PendingEscalation>("escalation", ESC_COLS, id),
    pendingTickets: (limit) => pending<PendingTicket>("ticket", TICKET_COLS, limit),
    ticket: (id) => one<PendingTicket>("ticket", TICKET_COLS, id),
    markNotified: (kind, id) => stamp(kind, id, "notified_at"),
    markEmailed: (kind, id) => stamp(kind, id, "emailed_at"),
    markUndeliveredAlerted: (kind, id) => stamp(kind, id, "undelivered_alerted_at"),
    async bumpAttempt(kind, id, channel) {
      const { table, key } = TABLE[kind];
      const column = channel === "discord" ? "notify_attempts" : "email_attempts";
      const { data, error } = await db.from(table).select(column).eq(key, id).maybeSingle();
      check(error, "bumpAttempt");
      const current = Number((data as Record<string, number> | null)?.[column] ?? 0);
      const { error: updateError } = await db.from(table).update({ [column]: current + 1 }).eq(key, id);
      check(updateError, "bumpAttempt");
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
