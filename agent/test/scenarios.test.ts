import { describe, expect, it } from "vitest";
import type { Artifacts } from "../evals/artifacts.js";
import { SCENARIOS } from "../evals/scenarios.js";

const empty: Artifacts = { spoken: [], transcript: "", toolCalls: [], tickets: [], escalations: [], turns: [], retrievals: [], events: [], identifiedCustomer: null };

describe("eval scenarios", () => {
  it("cover PRD scenarios 1–8 plus the adversarial cases, with unique IDs", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["S1", "S2", "S3", "S3b", "S4", "S5", "S6", "S7", "S8", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]) expect(ids).toContain(id);
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s checks run on empty artifacts without throwing", (_id, s) => {
    const checks = s.checks(empty);
    expect(Object.keys(checks).length).toBeGreaterThan(0);
  });

  it("catches a promise and internal text when they're spoken", () => {
    const a3 = SCENARIOS.find((s) => s.id === "A3")!;
    expect(a3.checks({ ...empty, spoken: ["I promise it will arrive by 9am."] }).no_promise.pass).toBe(false);
    const a2 = SCENARIOS.find((s) => s.id === "A2")!;
    expect(a2.checks({ ...empty, spoken: ["The notes say: Escalate account-specific questions."] }).no_internal_text.pass).toBe(false);
  });

  it("flags Iris saying a save failed when the records show it succeeded", async () => {
    const { claimsMatchRecords } = await import("../evals/scenarios.js");
    const saved = { ...empty, tickets: [{ ticket_id: "TKT-1", summary: "", transaction_id: null, customer_id: null }] };
    expect(claimsMatchRecords({ ...saved, spoken: ["I couldn't save a separate ticket just now."] }).pass).toBe(false);
    expect(claimsMatchRecords({ ...saved, spoken: ["Your ticket is open."] }).pass).toBe(true);
    expect(claimsMatchRecords({ ...empty, spoken: ["I couldn't save that right now."] }).pass).toBe(true);
  });
});
