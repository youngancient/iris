import { describe, expect, it } from "vitest";
import { maskEmails } from "../src/lib/mask.js";
import { normalizeEscalationCategory, normalizePriority, normalizeRef, normalizeTicketCategory } from "../src/lib/normalize.js";

describe("normalizeRef", () => {
  it.each([
    ["TXN-9001", "TXN-9001"],
    ["txn9001", "TXN-9001"],
    ["T X N 9 0 0 1", "TXN-9001"],
    ["txn nine zero zero one", "TXN-9001"],
    ["pay seven zero zero two", "PAY-7002"],
    ["7002", "PAY-7002"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeRef(raw, raw.startsWith("7") || raw.startsWith("pay") ? "PAY" : "TXN")).toBe(expected);
  });
});

describe("categories and priority", () => {
  it("ticket categories", () => {
    expect(normalizeTicketCategory("Payout")).toBe("payout");
    expect(normalizeTicketCategory("KYC question")).toBe("compliance");
    expect(normalizeTicketCategory("???")).toBe("other");
  });
  it("escalation categories only use the database's allowed values", () => {
    expect(normalizeEscalationCategory("account restriction")).toBe("account");
    expect(normalizeEscalationCategory("cancel my plan")).toBe("account");
    expect(normalizeEscalationCategory("angry customer")).toBe("other");
  });
  it("priority", () => {
    expect(normalizePriority("Critical")).toBe("urgent");
    expect(normalizePriority("whenever")).toBe("medium");
  });
});

describe("maskEmails", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmails("email amara@lagosledger.example please")).toBe("email a***@lagosledger.example please");
  });
});
