import { describe, expect, it } from "vitest";
import { connect, customers, seededDb, transactions } from "./helpers.js";

const AMARA = { company_name: "LagosLedger", email: "amara@lagosledger.example" };

describe("lookup_customer: identity comes only from signing in (design §5.2)", () => {
  const NOTHING = { found: false, customer_id: "", company_name: "", plan: "", account_status: "", kyc_status: "", support_notes: "" };

  it("not signed in: a company name reveals nothing, not even that the account exists", async () => {
    const { call } = await connect(seededDb());
    expect((await call("lookup_customer", { company_name: "LagosLedger" })).data).toEqual(NOTHING);
  });

  it("not signed in: company + the right email still reveals nothing, and doesn't verify the call", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    expect((await call("lookup_customer", AMARA)).data).toEqual(NOTHING);
    expect(await db.identifiedCustomer("conv-1")).toBeNull();
  });

  it("signed in as the customer: full details, with support_notes exactly as stored", async () => {
    for (const c of customers) {
      const { call } = await connect(seededDb(), "conv-1", c.customer_id);
      const { data } = await call("lookup_customer", { company_name: c.company_name });
      expect(data).toMatchObject({ found: true, customer_id: c.customer_id, plan: c.plan, support_notes: c.support_notes });
    }
  });

  it("signed in as one customer, asking about another: not found, and the attempt is recorded", async () => {
    const db = seededDb();
    const { call } = await connect(db, "conv-1", "CUS-1001");
    expect((await call("lookup_customer", { company_name: "CapeCloud" })).data.found).toBe(false);
    expect(db.events.map((e) => e.event_type)).toContain("identity_switch_blocked");
  });

  it("right company, wrong email: not found, and reveals nothing", async () => {
    const { call } = await connect(seededDb());
    const { data } = await call("lookup_customer", { company_name: "LagosLedger", email: "someone@else.example" });
    expect(data).toEqual({ found: false, customer_id: "", company_name: "", plan: "", account_status: "", kyc_status: "", support_notes: "" });
  });

  it("accepts messy spoken input", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    expect((await call("lookup_customer", { company_name: "lagos ledger" })).data.plan).toBe("Growth");
  });

  it("no identifiers at all is an error, not a crash", async () => {
    const { call } = await connect(seededDb());
    const result = await call("lookup_customer", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at least one/);
  });
});

describe("lookup_transaction ownership (design §5.2)", () => {
  it("caller not signed in: not found, even for a real reference (nothing to guess at)", async () => {
    const { call } = await connect(seededDb());
    expect((await call("lookup_transaction", { transaction_id: "TXN-9001" })).data.found).toBe(false);
  });

  it("signed-in owner: everything", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    const { data } = await call("lookup_transaction", { transaction_id: "TXN-9001" });
    expect(data).toMatchObject({
      found: true, status: "processing", type: "outgoing payout", amount: "2400", customer_id: "CUS-1001", currency: "USD",
      estimated_arrival: "2026-08-19", support_summary: transactions[0].support_summary,
    });
  });

  it("signed in as a different customer: not found (doesn't reveal the record exists)", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    const { data } = await call("lookup_transaction", { transaction_id: "TXN-9003" });
    expect(data.found).toBe(false);
  });

  it("normalises spoken references", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    for (const ref of ["txn 9001", "T X N nine zero zero one", "TXN.9001", "9001"]) {
      expect((await call("lookup_transaction", { transaction_id: ref })).data.transaction_id).toBe("TXN-9001");
    }
  });

  it("returns empty estimated_arrival rather than inventing one", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1003");
    expect((await call("lookup_transaction", { transaction_id: "TXN-9003" })).data.estimated_arrival).toBe("");
  });
});

describe("lookup_payout", () => {
  it("caller not signed in: not found, even for a real payout", async () => {
    const { call } = await connect(seededDb());
    expect((await call("lookup_payout", { payout_id: "PAY-7002" })).data.found).toBe(false);
  });

  it("signed in as a different customer: not found", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1001");
    expect((await call("lookup_payout", { payout_id: "PAY-7002" })).data.found).toBe(false);
  });

  it("PAY-7002 needs review, with the linked transaction's summary (signed in as its owner)", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1003");
    const { data } = await call("lookup_payout", { payout_id: "PAY-7002" });
    expect(data).toMatchObject({
      found: true, status: "review required", failure_reason: "compliance review",
      support_summary: "Transaction requires compliance review. Escalate account-specific questions.",
    });
  });

  it("finds a payout by its transaction", async () => {
    const { call } = await connect(seededDb(), "conv-1", "CUS-1004");
    expect((await call("lookup_payout", { transaction_id: "TXN-9004" })).data.payout_id).toBe("PAY-7003");
  });

  it("payout and transaction that don't belong together: not found", async () => {
    const { call } = await connect(seededDb());
    expect((await call("lookup_payout", { payout_id: "PAY-7001", transaction_id: "TXN-9004" })).data.found).toBe(false);
  });

  it("neither reference: error", async () => {
    const { call } = await connect(seededDb());
    expect((await call("lookup_payout", {})).isError).toBe(true);
  });
});

describe("create_support_ticket", () => {
  const ticket = { category: "payment", priority: "high", summary: "TXN-9001 hasn't arrived", conversation_id: "conv-1" };

  it("creates a ticket and links a transaction mentioned in the summary", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const { data } = await call("create_support_ticket", ticket);
    expect(data.status).toBe("open");
    expect(db.tickets[0]).toMatchObject({ transaction_id: "TXN-9001", priority: "high", category: "payment" });
  });

  it("doesn't link a reference that doesn't exist, but still creates the ticket", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("create_support_ticket", { ...ticket, summary: "Invoice payment TXN-4242 failed" });
    expect(db.tickets[0].transaction_id).toBeNull();
  });

  it("a retry returns the same ticket", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const first = await call("create_support_ticket", ticket);
    const second = await call("create_support_ticket", { ...ticket, summary: "Customer says TXN-9001 is late" });
    expect(second.data.ticket_id).toBe(first.data.ticket_id);
    expect(db.tickets).toHaveLength(1);
  });

  it("a reworded retry without a reference returns the same ticket", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const first = await call("create_support_ticket", { ...ticket, summary: "Payment stuck" });
    const second = await call("create_support_ticket", { ...ticket, summary: "The payment is stuck" });
    expect(second.data.ticket_id).toBe(first.data.ticket_id);
  });

  it("the same issue with a reference added later updates the first ticket instead of creating a second (S6)", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const first = await call("create_support_ticket", { ...ticket, category: "invoice", summary: "Invoice payment failed, caller wants it checked." });
    const second = await call("create_support_ticket", { ...ticket, category: "invoice", summary: "Failed invoice payment, reference TXN-9002." });
    expect(second.data.ticket_id).toBe(first.data.ticket_id);
    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0].summary).toMatch(/Invoice payment failed.*Update: .*TXN-9002/);
    expect(db.tickets[0].transaction_id).toBe("TXN-9002");
  });

  it("a different category in the same call is a separate ticket", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("create_support_ticket", { ...ticket, category: "invoice" });
    await call("create_support_ticket", { ...ticket, category: "account", summary: "Login problem" });
    expect(db.tickets).toHaveLength(2);
  });

  it("only the identified customer is attached; a model-supplied customer_id is not trusted", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("create_support_ticket", { ...ticket, customer_id: "CUS-1003" });
    expect(db.tickets[0].customer_id).toBeNull();
    expect(db.tickets[0].summary).toMatch(/not verified/);
  });

  it("maps unknown category and priority to safe values", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("create_support_ticket", { ...ticket, category: "something odd", priority: "asap!!" });
    expect(db.tickets[0]).toMatchObject({ category: "other", priority: "medium" });
  });

  it("uses the header conversation ID, and logs a mismatch", async () => {
    const db = seededDb();
    const { call } = await connect(db, "conv-real");
    await call("create_support_ticket", { ...ticket, conversation_id: "conv-forged" });
    expect(db.tickets[0].conversation_id).toBe("conv-real");
    expect(db.events.map((e) => e.event_type)).toContain("conversation_id_mismatch");
  });
});

describe("create_escalation", () => {
  const escalation = { user_name: "Efua Mensah", user_email: "efua@accrastack.example", category: "compliance", reason: "Account restricted" };

  it("creates an escalation, writes its own event, and gives a no-promise follow-up", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const { data } = await call("create_escalation", { ...escalation, preferred_time: "tomorrow morning" });
    expect(data.follow_up_summary).toBe("A RelayPay specialist will contact you at the email you provided, around tomorrow morning.");
    expect(db.escalations[0]).toMatchObject({ call_booked: true, category: "compliance" });
    expect(db.events.map((e) => e.event_type)).toEqual(["escalation_created"]);
  });

  it("asking twice returns the same escalation", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const first = await call("create_escalation", escalation);
    const second = await call("create_escalation", { ...escalation, reason: "Still restricted" });
    expect(second.data.escalation_id).toBe(first.data.escalation_id);
    expect(db.escalations).toHaveLength(1);
    expect(db.events).toHaveLength(1);
  });

  it("a missing field is an error that names it", async () => {
    const { call } = await connect(seededDb());
    const result = await call("create_escalation", { ...escalation, user_name: " " });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/user_name/);
  });

  it("rejects a malformed email", async () => {
    const { call } = await connect(seededDb());
    expect((await call("create_escalation", { ...escalation, user_email: "efua at accrastack" })).isError).toBe(true);
  });

  it("maps free-text categories onto the database's allowed values", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("create_escalation", { ...escalation, category: "Refund request" });
    expect(db.escalations[0].category).toBe("dispute");
  });
});

describe("log_conversation_event", () => {
  it("logs any event type", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    const { data } = await call("log_conversation_event", {
      conversation_id: "conv-1", event_type: "Clarification Requested", summary: "Asked which payment", metadata: { a: 1 },
    });
    expect(data).toEqual({ logged: true });
    expect(db.events[0]).toMatchObject({ event_type: "clarification_requested", metadata: { a: 1 } });
  });
});

describe("logging and failures", () => {
  it("every call writes a tool_calls row with emails masked", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("lookup_customer", AMARA);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.toolCalls).toHaveLength(1);
    expect(db.toolCalls[0]).toMatchObject({ tool_name: "lookup_customer", status: "not_found", conversation_id: "conv-1" });
    expect(JSON.stringify(db.toolCalls[0].input_summary)).toContain("a***@lagosledger.example");
    expect(JSON.stringify(db.toolCalls[0])).not.toContain("amara@");
  });

  it("not found is logged as not_found, not error", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    await call("lookup_transaction", { transaction_id: "TXN-0000" });
    expect(db.toolCalls[0].status).toBe("not_found");
  });

  it("database down: isError with a plain message, internal error kept out of the reply", async () => {
    const db = seededDb();
    const { call } = await connect(db);
    db.failing = true;
    const result = await call("lookup_transaction", { transaction_id: "TXN-9001" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Transaction lookup is temporarily unavailable. Please try again shortly.");
    expect(result.text).not.toMatch(/database/);
  });

  it("a tool past its deadline answers in time with a safe-to-retry message, and logs the real outcome later", async () => {
    const db = seededDb();
    const slowInsert = db.insertTicket.bind(db);
    db.insertTicket = async (row) => {
      await new Promise((r) => setTimeout(r, 80));
      return slowInsert(row);
    };
    const server = (await import("../src/server.js")).buildServer({ db, conversationId: "conv-1", turnIndex: 0, deadlineMs: 20 });
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const result = await client.callTool({
      name: "create_support_ticket",
      arguments: { category: "payment", priority: "high", summary: "TXN-9001 late", conversation_id: "conv-1" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Calling this tool again with the same details is harmless/);
    await new Promise((r) => setTimeout(r, 150));
    expect(db.tickets).toHaveLength(1);
    expect(db.toolCalls[0]).toMatchObject({ status: "success" });
    expect(db.toolCalls[0].error_message).toMatch(/after the 20ms deadline/);
  });
});
