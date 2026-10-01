import { createClient, type PostgrestError } from "@supabase/supabase-js";
import type { CustomerRow, Db, PayoutRow, RecentTicket, TransactionRow } from "./types.js";

const QUERY_TIMEOUT_MS = 4000;

const CUSTOMER_COLUMNS = "customer_id, company_name, contact_email, plan, account_status, kyc_status, support_notes";
const TRANSACTION_COLUMNS =
  "transaction_id, customer_id, transaction_type, amount, currency, status, estimated_arrival, support_summary";
const PAYOUT_COLUMNS = "payout_id, transaction_id, customer_id, status, scheduled_for, failure_reason";

// ilike with no wildcards = case-insensitive equality. Escape the caller's own wildcards.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function check(error: PostgrestError | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export function createSupabaseDb(url: string, serviceKey: string): Db {
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
    // Every query gets the same hard timeout, so a slow database can't hang a call.
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
    },
  });

  return {
    async customerById(id) {
      const { data, error } = await client.from("customers").select(CUSTOMER_COLUMNS).eq("customer_id", id).maybeSingle();
      check(error, "customerById");
      return data as CustomerRow | null;
    },

    async customersByEmail(email) {
      const { data, error } = await client
        .from("customers")
        .select(CUSTOMER_COLUMNS)
        .ilike("contact_email", escapeLike(email))
        .limit(5);
      check(error, "customersByEmail");
      return (data ?? []) as CustomerRow[];
    },

    async customersByCompany(name) {
      const { data, error } = await client
        .from("customers")
        .select(CUSTOMER_COLUMNS)
        .ilike("company_name", escapeLike(name))
        .limit(5);
      check(error, "customersByCompany");
      if (data && data.length > 0) return data as CustomerRow[];
      // Speech-to-text often splits names ("Lagos Ledger" for LagosLedger).
      const compact = name.replace(/\s+/g, "");
      if (compact === name) return [];
      const retry = await client.from("customers").select(CUSTOMER_COLUMNS).ilike("company_name", escapeLike(compact)).limit(5);
      check(retry.error, "customersByCompany");
      return (retry.data ?? []) as CustomerRow[];
    },

    async transactionById(id) {
      const { data, error } = await client
        .from("transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("transaction_id", id)
        .maybeSingle();
      check(error, "transactionById");
      return data as TransactionRow | null;
    },

    async payoutById(id) {
      const { data, error } = await client.from("payouts").select(PAYOUT_COLUMNS).eq("payout_id", id).maybeSingle();
      check(error, "payoutById");
      return data as PayoutRow | null;
    },

    async payoutByTransactionId(id) {
      const { data, error } = await client.from("payouts").select(PAYOUT_COLUMNS).eq("transaction_id", id).limit(1);
      check(error, "payoutByTransactionId");
      return ((data ?? [])[0] ?? null) as PayoutRow | null;
    },

    async identifiedCustomer(conversationId) {
      const { data, error } = await client
        .from("conversations")
        .select("identified_customer_id")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      check(error, "identifiedCustomer");
      return (data?.identified_customer_id as string | null) ?? null;
    },

    async setIdentifiedCustomer(conversationId, customerId) {
      const { error } = await client
        .from("conversations")
        .upsert({ conversation_id: conversationId, identified_customer_id: customerId }, { onConflict: "conversation_id" });
      check(error, "setIdentifiedCustomer");
    },

    async ticketExists(ticketId) {
      const { data, error } = await client.from("support_tickets").select("ticket_id").eq("ticket_id", ticketId).maybeSingle();
      check(error, "ticketExists");
      return data !== null;
    },

    async insertTicket(row) {
      if (row.idempotency_key) {
        const { error } = await client
          .from("support_tickets")
          .upsert(row, { onConflict: "idempotency_key", ignoreDuplicates: true });
        check(error, "insertTicket");
        const existing = await client
          .from("support_tickets")
          .select("ticket_id, status")
          .eq("idempotency_key", row.idempotency_key)
          .single();
        check(existing.error, "insertTicket");
        return existing.data as { ticket_id: string; status: string };
      }
      const { data, error } = await client.from("support_tickets").insert(row).select("ticket_id, status").single();
      check(error, "insertTicket");
      return data as { ticket_id: string; status: string };
    },

    async recentTicket(conversationId, category, customerId, sinceIso) {
      let query = client
        .from("support_tickets")
        .select("ticket_id, status, summary, transaction_id")
        .eq("conversation_id", conversationId)
        .eq("category", category)
        .neq("status", "closed")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1);
      query = customerId ? query.eq("customer_id", customerId) : query.is("customer_id", null);
      const { data, error } = await query;
      check(error, "recentTicket");
      return ((data ?? [])[0] ?? null) as RecentTicket | null;
    },

    async updateTicket(ticketId, fields) {
      const { error } = await client.from("support_tickets").update(fields).eq("ticket_id", ticketId);
      check(error, "updateTicket");
    },

    async insertEscalation(row) {
      const { data, error } = await client.from("escalations").insert(row).select("escalation_id, status").single();
      if (!error) return { ...(data as { escalation_id: string; status: string }), created: true };
      // 23505 = unique violation on the one-open-escalation-per-category index.
      if (error.code !== "23505" || !row.conversation_id) check(error, "insertEscalation");
      const existing = await client
        .from("escalations")
        .select("escalation_id, status")
        .eq("conversation_id", row.conversation_id!)
        .eq("category", row.category)
        .neq("status", "closed")
        .single();
      check(existing.error, "insertEscalation");
      return { ...(existing.data as { escalation_id: string; status: string }), created: false };
    },

    async insertEvent(row) {
      const { error } = await client.from("conversation_events").insert(row);
      check(error, "insertEvent");
    },

    async countEvents(conversationId, eventType) {
      const { count, error } = await client
        .from("conversation_events")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("event_type", eventType);
      check(error, "countEvents");
      return count ?? 0;
    },

    async countCustomerEvents(eventType, customerId, sinceIso) {
      const { count, error } = await client
        .from("conversation_events")
        .select("*", { count: "exact", head: true })
        .eq("event_type", eventType)
        .eq("metadata->>customer_id", customerId)
        .gte("created_at", sinceIso);
      check(error, "countCustomerEvents");
      return count ?? 0;
    },

    async insertToolCall(row) {
      const { error } = await client.from("tool_calls").insert(row);
      check(error, "insertToolCall");
    },
  };
}
