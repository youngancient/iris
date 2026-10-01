// Plain-language labels for what happened on a call (design §15: no jargon for staff).

const TOOL_LABELS: Record<string, string> = {
  lookup_customer: "Checked the caller's account",
  lookup_transaction: "Looked up a transaction",
  lookup_payout: "Looked up a payout",
  create_support_ticket: "Created a support ticket",
  create_escalation: "Escalated to a specialist",
  log_conversation_event: "Noted a decision",
};

export function toolLabel(tool: string, input: Record<string, unknown> | null, result: Record<string, unknown> | null, status: string): string {
  const base = TOOL_LABELS[tool] ?? tool;
  const ref = input?.transaction_id ?? input?.payout_id ?? result?.ticket_id ?? result?.escalation_id;
  const suffix = ref ? ` ${ref}` : "";
  if (status === "error") return `${base}${suffix}: it failed`;
  if (status === "not_found") return `${base}${suffix}: not found`;
  return `${base}${suffix}`;
}

const EVENT_LABELS: Record<string, string> = {
  internal_text_blocked: "A sentence was held back for safety",
  guarantee_blocked: "A sentence promising an outcome was held back",
  escalation_created: "Escalation recorded",
  declined: "Iris declined the question",
  clarification_requested: "Iris asked a clarifying question",
  missed_followup: "A record needed follow-up but no ticket was created",
  mcp_unavailable: "Iris couldn't reach customer records",
  tool_error_seen: "A lookup or action failed",
  ungrounded_answer: "Iris answered without approved knowledge",
  follow_up_status_seen: "A record needs specialist follow-up",
  conversation_id_mismatch: "A tool call used the wrong call reference (ignored)",
  identity_check_failed: "Caller's details didn't match",
  identity_attempt_failed: "Caller's details didn't match",
  identity_attempts_exceeded: "Verification closed after too many failed attempts",
  identity_switch_blocked: "Caller tried to verify as a second customer (blocked)",
  lookup_rate_limited: "Too many lookups without verification (blocked)",
  escalation_undelivered: "The team wasn't notified of this escalation in time",
  call_token_invalid: "Call refused: it wasn't started from the RelayPay page",
  cost_cap_reached: "Call ended at the spending limit",
};

/** Bookkeeping events that aren't worth showing in a transcript. */
export const HIDDEN_EVENTS = new Set(["anonymous_lookup", "escalation_created", "follow_up_status_seen"]);

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ");
}

export const OUTCOME_LABEL: Record<string, string> = {
  escalated: "Escalated",
  ticketed: "Ticket created",
  resolved: "Answered",
  abandoned: "Ended early",
};

export const ANSWER_LABEL: Record<string, string> = {
  answer: "Answered",
  clarify: "Asked a question",
  escalate: "Escalated",
  decline: "Declined",
};
