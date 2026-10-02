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
  it("never return a record, however many are tried, so references can't be guessed", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 6; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(false);
    expect((await call("lookup_payout", { payout_id: "PAY-7001" })).data.found).toBe(false);
    expect((await call("lookup_customer", { company_name: "LagosLedger" })).data.found).toBe(false);
  });

  it("don't apply to a signed-in owner", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    for (let i = 0; i < 7; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
  });
});

describe("a local stdio operator", () => {
  it("sees every record, with no call and nobody signed in", async () => {
    const { call } = await connect(seededDb(), null, undefined, { operator: true });
    expect((await call("lookup_transaction", { transaction_id: "TXN-9003" })).data).toMatchObject({ found: true, amount: "5300", customer_id: "CUS-1003" });
    expect((await call("lookup_payout", { payout_id: "PAY-7002" })).data).toMatchObject({ found: true, status: "review required" });
    expect((await call("lookup_customer", { company_name: "AccraStack" })).data).toMatchObject({ found: true, plan: "Scale" });
  });

  it("is never the default: without the operator flag, the same lookups find nothing", async () => {
    const { call } = await connect(seededDb(), null);
    expect((await call("lookup_transaction", { transaction_id: "TXN-9003" })).data.found).toBe(false);
  });
});
