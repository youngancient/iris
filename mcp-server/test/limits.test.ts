import { describe, expect, it } from "vitest";
import { connect, seededDb } from "./helpers.js";

const types = (db: ReturnType<typeof seededDb>) => db.events.map((e) => e.event_type);

describe("identity lock", () => {
  it("signed in as one customer, a match to a different customer returns not found", async () => {
    const db = seededDb();
    const { call } = await connect(db, "conv-1", "CUS-1001");
    const { data } = await call("lookup_customer", { company_name: "CapeCloud", email: "amina@capecloud.example" });
    expect(data.found).toBe(false);
    expect(await db.identifiedCustomer("conv-1")).toBe("CUS-1001");
    expect(types(db)).toContain("identity_switch_blocked");
  });

  it("guessing emails can't verify anyone: nothing a caller says changes who the call is signed in as", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (const email of ["a@x.example", "amara@lagosledger.example"]) await call("lookup_customer", { company_name: "LagosLedger", email });
    expect(await db.identifiedCustomer("conv-1")).toBeNull();
  });
});

describe("lookups without signing in", () => {
  it("are capped at 5 per call; the 6th returns not found", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 5; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
    expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(false);
    expect((await call("lookup_payout", { payout_id: "PAY-7001" })).data.found).toBe(false);
    expect(types(db)).toContain("lookup_rate_limited");
  });

  it("don't apply to a signed-in owner", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    for (let i = 0; i < 7; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
  });

  it("not-found references don't use up the allowance", async () => {
    const { call } = await connect(seededDb());
    for (let i = 0; i < 10; i++) await call("lookup_transaction", { transaction_id: `TXN-${1000 + i}` });
    expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
  });
});
