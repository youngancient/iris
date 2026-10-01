// Data access used by the tools. Two implementations: Supabase (real) and
// in-memory (tests). Keeping tools behind this interface means every rule in
// the tools is testable without a database.

export type CustomerRow = {
  customer_id: string;
  company_name: string;
  contact_email: string | null;
  plan: string | null;
  account_status: string | null;
  kyc_status: string | null;
  support_notes: string | null;
};

export type TransactionRow = {
  transaction_id: string;
  customer_id: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  currency: string | null;
  status: string | null;
  estimated_arrival: string | null;
  support_summary: string | null;
};

export type PayoutRow = {
  payout_id: string;
  transaction_id: string | null;
  customer_id: string | null;
  status: string | null;
  scheduled_for: string | null;
  failure_reason: string | null;
};

export type TicketInsert = {
  conversation_id: string | null;
  customer_id: string | null;
  transaction_id: string | null;
  category: string;
  priority: string;
  summary: string;
  idempotency_key: string | null;
};

export type RecentTicket = { ticket_id: string; status: string; summary: string; transaction_id: string | null };

export type EscalationInsert = {
  conversation_id: string | null;
  ticket_id: string | null;
  customer_id: string | null;
  user_name: string;
  user_email: string;
  category: string;
  reason: string;
  call_booked: boolean;
  preferred_time: string | null;
};

export type EventInsert = {
  conversation_id: string | null;
  event_type: string;
  summary: string | null;
  metadata: Record<string, unknown>;
};

export type ToolCallInsert = {
  conversation_id: string | null;
  turn_index: number | null;
  tool_name: string;
  purpose: string;
  input_summary: unknown;
  result_summary: unknown;
  status: "success" | "not_found" | "error";
  error_message: string | null;
  duration_ms: number;
  idempotency_key: string | null;
};

export interface Db {
  customerById(id: string): Promise<CustomerRow | null>;
  customersByEmail(email: string): Promise<CustomerRow[]>;
  customersByCompany(name: string): Promise<CustomerRow[]>;
  transactionById(id: string): Promise<TransactionRow | null>;
  payoutById(id: string): Promise<PayoutRow | null>;
  payoutByTransactionId(id: string): Promise<PayoutRow | null>;

  identifiedCustomer(conversationId: string): Promise<string | null>;
  setIdentifiedCustomer(conversationId: string, customerId: string): Promise<void>;

  ticketExists(ticketId: string): Promise<boolean>;
  /** Insert, or return the existing ticket with the same idempotency key. */
  insertTicket(row: TicketInsert): Promise<{ ticket_id: string; status: string }>;
  /** The latest open ticket for this conversation and category created since sinceIso. */
  recentTicket(
    conversationId: string,
    category: string,
    customerId: string | null,
    sinceIso: string,
  ): Promise<RecentTicket | null>;
  /** Adds new details to an existing ticket (e.g. a reference the caller gave later). */
  updateTicket(ticketId: string, fields: { summary: string; transaction_id: string | null }): Promise<void>;

  /** Insert, or return the open escalation for the same conversation and category. */
  insertEscalation(row: EscalationInsert): Promise<{ escalation_id: string; status: string; created: boolean }>;

  insertEvent(row: EventInsert): Promise<void>;
  /** Events of a type in one conversation (limits are counted from these, design §5.2). */
  countEvents(conversationId: string, eventType: string): Promise<number>;
  /** Events of a type recorded against a customer (metadata.customer_id) since a time, across calls. */
  countCustomerEvents(eventType: string, customerId: string, sinceIso: string): Promise<number>;
  insertToolCall(row: ToolCallInsert): Promise<void>;
}
