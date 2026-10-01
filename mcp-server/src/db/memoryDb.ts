import { randomBytes } from "node:crypto";
import type {
  CustomerRow,
  Db,
  EscalationInsert,
  EventInsert,
  PayoutRow,
  TicketInsert,
  ToolCallInsert,
  TransactionRow,
} from "./types.js";

// In-memory Db for tests. Mirrors the constraints the SQL migrations enforce
// (ticket idempotency key, one open escalation per conversation and category).

type Seed = { customers?: CustomerRow[]; transactions?: TransactionRow[]; payouts?: PayoutRow[] };

const id = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;

export class MemoryDb implements Db {
  customers: CustomerRow[];
  transactions: TransactionRow[];
  payouts: PayoutRow[];
  conversations = new Map<string, { identified_customer_id: string | null }>();
  tickets: (TicketInsert & { ticket_id: string; status: string; created_at: string })[] = [];
  escalations: (EscalationInsert & { escalation_id: string; status: string })[] = [];
  events: (EventInsert & { created_at?: string })[] = [];
  toolCalls: ToolCallInsert[] = [];
  /** Set to make every call fail, simulating the database being down. */
  failing = false;

  constructor(seed: Seed = {}) {
    this.customers = seed.customers ?? [];
    this.transactions = seed.transactions ?? [];
    this.payouts = seed.payouts ?? [];
  }

  private guard() {
    if (this.failing) throw new Error("database unavailable");
  }

  async customerById(customerId: string) {
    this.guard();
    return this.customers.find((c) => c.customer_id === customerId) ?? null;
  }
  async customersByEmail(email: string) {
    this.guard();
    return this.customers.filter((c) => c.contact_email?.toLowerCase() === email.toLowerCase());
  }
  async customersByCompany(name: string) {
    this.guard();
    const hits = this.customers.filter((c) => c.company_name.toLowerCase() === name.toLowerCase());
    if (hits.length > 0) return hits;
    const compact = name.replace(/\s+/g, "").toLowerCase();
    return this.customers.filter((c) => c.company_name.toLowerCase() === compact);
  }
  async transactionById(transactionId: string) {
    this.guard();
    return this.transactions.find((t) => t.transaction_id === transactionId) ?? null;
  }
  async payoutById(payoutId: string) {
    this.guard();
    return this.payouts.find((p) => p.payout_id === payoutId) ?? null;
  }
  async payoutByTransactionId(transactionId: string) {
    this.guard();
    return this.payouts.find((p) => p.transaction_id === transactionId) ?? null;
  }
  async identifiedCustomer(conversationId: string) {
    this.guard();
    return this.conversations.get(conversationId)?.identified_customer_id ?? null;
  }
  async setIdentifiedCustomer(conversationId: string, customerId: string) {
    this.guard();
    this.conversations.set(conversationId, { identified_customer_id: customerId });
  }
  async ticketExists(ticketId: string) {
    this.guard();
    return this.tickets.some((t) => t.ticket_id === ticketId);
  }
  async insertTicket(row: TicketInsert) {
    this.guard();
    const existing = row.idempotency_key && this.tickets.find((t) => t.idempotency_key === row.idempotency_key);
    if (existing) return { ticket_id: existing.ticket_id, status: existing.status };
    const ticket = { ...row, ticket_id: id("TKT"), status: "open", created_at: new Date().toISOString() };
    this.tickets.push(ticket);
    return { ticket_id: ticket.ticket_id, status: ticket.status };
  }
  async recentTicket(conversationId: string, category: string, customerId: string | null, sinceIso: string) {
    this.guard();
    const hit = this.tickets
      .filter(
        (t) =>
          t.conversation_id === conversationId &&
          t.category === category &&
          t.customer_id === customerId &&
          t.status !== "closed" &&
          t.created_at >= sinceIso,
      )
      .at(-1);
    return hit ? { ticket_id: hit.ticket_id, status: hit.status, summary: hit.summary, transaction_id: hit.transaction_id } : null;
  }
  async updateTicket(ticketId: string, fields: { summary: string; transaction_id: string | null }) {
    this.guard();
    const t = this.tickets.find((x) => x.ticket_id === ticketId);
    if (t) Object.assign(t, fields);
  }
  async insertEscalation(row: EscalationInsert) {
    this.guard();
    const open = this.escalations.find(
      (e) => row.conversation_id && e.conversation_id === row.conversation_id && e.category === row.category && e.status !== "closed",
    );
    if (open) return { escalation_id: open.escalation_id, status: open.status, created: false };
    const escalation = { ...row, escalation_id: id("ESC"), status: "open" };
    this.escalations.push(escalation);
    return { escalation_id: escalation.escalation_id, status: escalation.status, created: true };
  }
  async insertEvent(row: EventInsert) {
    this.guard();
    this.events.push({ ...row, created_at: new Date().toISOString() });
  }
  async countEvents(conversationId: string, eventType: string) {
    this.guard();
    return this.events.filter((e) => e.conversation_id === conversationId && e.event_type === eventType).length;
  }
  async insertToolCall(row: ToolCallInsert) {
    this.guard();
    this.toolCalls.push(row);
  }
}
