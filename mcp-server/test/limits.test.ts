import { describe, expect, it } from "vitest";
import { connect, seededDb } from "./helpers.js";

const AMARA = { company_name: "LagosLedger", email: "amara@lagosledger.example" };
const wrong = (n: number) => ({ company_name: "LagosLedger", email: `guess${n}@else.example` });
const types = (db: ReturnType<typeof seededDb>) => db.events.map((e) => e.event_type);

describe("identity attempt limits (design §5.2)", () => {
  it("after 3 failed attempts in a call, even the right details return not found", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 3; i++) expect((await call("lookup_customer", wrong(i))).data.found).toBe(false);
    const { data } = await call("lookup_customer", AMARA);
    expect(data.found).toBe(false);
    expect(await db.identifiedCustomer("conv-1")).toBeNull();
    expect(types(db)).toContain("identity_attempts_exceeded");
  });

  it("two failures then the right details still identifies", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("lookup_customer", wrong(1));
    await call("lookup_customer", wrong(2));
    expect((await call("lookup_customer", AMARA)).data.plan).toBe("Growth");
  });

  it("a single identifier isn't an attempt and isn't counted", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 4; i++) await call("lookup_customer", { company_name: "LagosLedger" });
    expect((await call("lookup_customer", AMARA)).data.found).toBe(true);
    expect(types(db)).not.toContain("identity_attempt_failed");
  });

  it("5 failures against one customer across calls lock that customer, but not others", async () => {
    const db = seededDb();
    for (let c = 0; c < 3; c++) {
      const { call } = await connect(db, `conv-${c}`);
      await call("lookup_customer", wrong(c * 2));
      if (c < 2) await call("lookup_customer", wrong(c * 2 + 1));
    }
    const fresh = await connect(db, "conv-new");
    expect((await fresh.call("lookup_customer", AMARA)).data.found).toBe(false);
    const other = await connect(db, "conv-other");
    expect((await other.call("lookup_customer", { company_name: "CapeCloud", email: "amina@capecloud.example" })).data.found).toBe(true);
  });

  it("failures are counted against the targeted customer", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("lookup_customer", wrong(1));
    expect(db.events.find((e) => e.event_type === "identity_attempt_failed")?.metadata.customer_id).toBe("CUS-1001");
  });
});

describe("identity lock", () => {
  it("once verified, a match to a different customer returns not found", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("lookup_customer", AMARA);
    const { data } = await call("lookup_customer", { company_name: "CapeCloud", email: "amina@capecloud.example" });
    expect(data.found).toBe(false);
    expect(await db.identifiedCustomer("conv-1")).toBe("CUS-1001");
    expect(types(db)).toContain("identity_switch_blocked");
  });

  it("re-confirming the same customer is fine", async () => {
    const { call } = await connect(seededDb());
    await call("lookup_customer", AMARA);
    expect((await call("lookup_customer", { customer_id: "CUS-1001", email: "amara@lagosledger.example" })).data.plan).toBe("Growth");
  });
});

describe("lookups by unverified callers", () => {
  it("are capped at 5 per call; the 6th returns not found", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 5; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
    expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(false);
    expect((await call("lookup_payout", { payout_id: "PAY-7001" })).data.found).toBe(false);
    expect(types(db)).toContain("lookup_rate_limited");
  });

  it("don't apply once the caller is verified as the owner", async () => {
    const { call } = await connect(seededDb());
    await call("lookup_customer", AMARA);
    for (let i = 0; i < 7; i++) expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
  });

  it("not-found references don't use up the allowance", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    for (let i = 0; i < 10; i++) await call("lookup_transaction", { transaction_id: `TXN-${1000 + i}` });
    expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(true);
  });
});
