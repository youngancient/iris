// Input clean-up that doesn't change the tool schemas (design §5.3).
// Speech-to-text hands us things like "T X N nine zero zero one" or "txn 9001".

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/** "" and whitespace-only count as not provided. */
export function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalise a reference like TXN-9001, PAY-7002, CUS-1003.
 * Accepts spaces, dots, missing dashes, lowercase and spoken digits.
 * A bare number gets the expected prefix ("9001" → "TXN-9001").
 */
export function normalizeRef(raw: string, prefix: "TXN" | "PAY" | "CUS"): string {
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = tokens.map((t) => DIGIT_WORDS[t] ?? t).join("").toUpperCase();
  const match = /^([A-Z]*)(\d+)$/.exec(joined);
  if (!match) return joined;
  const [, letters, digits] = match;
  return `${letters || prefix}-${digits}`;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

export function normalizeCompany(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

// support_tickets.category is free text in the database; keep it to a small known set.
const TICKET_CATEGORIES = [
  "payment", "payout", "invoice", "account", "compliance", "dispute",
  "refund", "cancellation", "onboarding", "fees", "technical", "other",
] as const;

const TICKET_CATEGORY_ALIASES: Record<string, (typeof TICKET_CATEGORIES)[number]> = {
  transfer: "payment", transaction: "payment", invoicing: "invoice", kyc: "compliance",
  verification: "compliance", pricing: "fees", fee: "fees", bug: "technical", login: "account",
};

export function normalizeTicketCategory(raw: string): string {
  const key = raw.trim().toLowerCase();
  if ((TICKET_CATEGORIES as readonly string[]).includes(key)) return key;
  for (const [alias, category] of Object.entries(TICKET_CATEGORY_ALIASES)) {
    if (key.includes(alias)) return category;
  }
  for (const category of TICKET_CATEGORIES) if (key.includes(category)) return category;
  return "other";
}

// escalations.category has a database check constraint with exactly these values.
const ESCALATION_CATEGORY_ALIASES: [string, "compliance" | "account" | "dispute" | "payment" | "other"][] = [
  ["compliance", "compliance"], ["kyc", "compliance"], ["verification", "compliance"], ["restrict", "account"],
  ["account", "account"], ["cancel", "account"], ["dispute", "dispute"], ["refund", "dispute"],
  ["chargeback", "dispute"], ["payment", "payment"], ["payout", "payment"], ["invoice", "payment"],
  ["transfer", "payment"], ["transaction", "payment"],
];

export function normalizeEscalationCategory(raw: string): string {
  const key = raw.trim().toLowerCase();
  for (const [alias, category] of ESCALATION_CATEGORY_ALIASES) if (key.includes(alias)) return category;
  return "other";
}

const PRIORITIES: Record<string, string> = {
  low: "low", minor: "low", medium: "medium", normal: "medium", moderate: "medium",
  high: "high", important: "high", urgent: "urgent", critical: "urgent",
};

export function normalizePriority(raw: string): string {
  return PRIORITIES[raw.trim().toLowerCase()] ?? "medium";
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
