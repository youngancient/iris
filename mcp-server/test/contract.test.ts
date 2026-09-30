// Spec contract: tool names, inputs and outputs must match
// artifact/assets/mcp-tool-requirements.md exactly (design §5.0).
import { describe, expect, it } from "vitest";
import { connect, seededDb } from "./helpers.js";

const SPEC = {
  lookup_customer: {
    required: [],
    optional: ["customer_id", "email", "company_name"],
    output: ["found", "customer_id", "company_name", "plan", "account_status", "kyc_status", "support_notes"],
    sample: { company_name: "LagosLedger", email: "amara@lagosledger.example" },
  },
  lookup_transaction: {
    required: ["transaction_id"],
    optional: [],
    output: ["found", "transaction_id", "customer_id", "type", "status", "amount", "currency", "estimated_arrival", "support_summary"],
    sample: { transaction_id: "TXN-9001" },
  },
  lookup_payout: {
    required: [],
    optional: ["payout_id", "transaction_id"],
    output: ["found", "payout_id", "status", "scheduled_for", "failure_reason", "support_summary"],
    sample: { payout_id: "PAY-7002" },
  },
  create_support_ticket: {
    required: ["category", "priority", "summary", "conversation_id"],
    optional: ["customer_id"],
    output: ["ticket_id", "status"],
    sample: { category: "payment", priority: "medium", summary: "Payment stuck", conversation_id: "conv-1" },
  },
  create_escalation: {
    required: ["user_name", "user_email", "category", "reason"],
    optional: ["ticket_id", "customer_id", "preferred_time"],
    output: ["escalation_id", "status", "follow_up_summary"],
    sample: { user_name: "Efua Mensah", user_email: "efua@accrastack.example", category: "compliance", reason: "Account restricted" },
  },
  log_conversation_event: {
    required: ["conversation_id", "event_type", "summary", "metadata"],
    optional: [],
    output: ["logged"],
    sample: { conversation_id: "conv-1", event_type: "clarification_requested", summary: "Asked which payment", metadata: {} },
  },
} as const;

describe("spec contract", () => {
  it("exposes exactly the six spec tools", async () => {
    const { client } = await connect(seededDb());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(SPEC).sort());
  });

  for (const [name, spec] of Object.entries(SPEC)) {
    describe(name, () => {
      it("has the spec's input fields, with the same required/optional split", async () => {
        const { client } = await connect(seededDb());
        const tool = (await client.listTools()).tools.find((t) => t.name === name)!;
        const properties = Object.keys(tool.inputSchema.properties ?? {}).sort();
        expect(properties).toEqual([...spec.required, ...spec.optional].sort());
        expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([...spec.required].sort());
      });

      it("declares exactly the spec's output fields", async () => {
        const { client } = await connect(seededDb());
        const tool = (await client.listTools()).tools.find((t) => t.name === name)!;
        expect(Object.keys(tool.outputSchema?.properties ?? {}).sort()).toEqual([...spec.output].sort());
      });

      it("returns every output field, with no nulls and no extras", async () => {
        const { call } = await connect(seededDb());
        const { isError, data, text } = await call(name, spec.sample);
        expect(isError).toBe(false);
        expect(Object.keys(data).sort()).toEqual([...spec.output].sort());
        for (const value of Object.values(data)) expect(value).not.toBeNull();
        expect(JSON.parse(text)).toEqual(data);
      });
    });
  }

  it("returns all-empty strings, not nulls, when a record is not found", async () => {
    const { call } = await connect(seededDb());
    const { data } = await call("lookup_transaction", { transaction_id: "TXN-0000" });
    expect(data).toEqual({
      found: false, transaction_id: "", customer_id: "", type: "", status: "", amount: "",
      currency: "", estimated_arrival: "", support_summary: "",
    });
  });
});
