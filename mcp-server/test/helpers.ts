import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryDb } from "../src/db/memoryDb.js";
import type { CustomerRow, PayoutRow, TransactionRow } from "../src/db/types.js";
import { buildServer } from "../src/server.js";

// The provided RelayPay seed rows (artifact/assets/seed-data), as the tools read them.
export const customers: CustomerRow[] = [
  { customer_id: "CUS-1001", company_name: "LagosLedger", contact_email: "amara@lagosledger.example", plan: "Growth", account_status: "active", kyc_status: "approved", support_notes: "Customer has an active account and normal support access." },
  { customer_id: "CUS-1002", company_name: "NairobiOps", contact_email: "daniel@nairobiops.example", plan: "Starter", account_status: "pending verification", kyc_status: "pending", support_notes: "Customer needs to complete business verification before full payment access." },
  { customer_id: "CUS-1003", company_name: "AccraStack", contact_email: "efua@accrastack.example", plan: "Scale", account_status: "restricted", kyc_status: "review required", support_notes: "Account is under compliance review. Escalate account-specific questions." },
  { customer_id: "CUS-1004", company_name: "CapeCloud", contact_email: "amina@capecloud.example", plan: "Growth", account_status: "active", kyc_status: "approved", support_notes: "Customer often uses contractor payouts." },
  { customer_id: "CUS-1005", company_name: "KigaliWorks", contact_email: "patrick@kigaliworks.example", plan: "Starter", account_status: "active", kyc_status: "approved", support_notes: "Customer recently started multi-currency invoicing." },
];

export const transactions: TransactionRow[] = [
  { transaction_id: "TXN-9001", customer_id: "CUS-1001", transaction_type: "outgoing payout", amount: 2400, currency: "USD", status: "processing", estimated_arrival: "2026-08-19", support_summary: "Payout is processing within the normal expected window." },
  { transaction_id: "TXN-9002", customer_id: "CUS-1002", transaction_type: "invoice payment", amount: 1200, currency: "EUR", status: "completed", estimated_arrival: "2026-08-15", support_summary: "Invoice payment completed." },
  { transaction_id: "TXN-9003", customer_id: "CUS-1003", transaction_type: "outgoing payout", amount: 5300, currency: "GBP", status: "review required", estimated_arrival: null, support_summary: "Transaction requires compliance review. Escalate account-specific questions." },
  { transaction_id: "TXN-9004", customer_id: "CUS-1004", transaction_type: "outgoing payout", amount: 800, currency: "USD", status: "failed", estimated_arrival: null, support_summary: "Payout failed because beneficiary details need review." },
  { transaction_id: "TXN-9005", customer_id: "CUS-1005", transaction_type: "incoming transfer", amount: 3100, currency: "EUR", status: "delayed", estimated_arrival: "2026-08-18", support_summary: "Incoming transfer is delayed due to partner bank processing." },
];

export const payouts: PayoutRow[] = [
  { payout_id: "PAY-7001", transaction_id: "TXN-9001", customer_id: "CUS-1001", status: "processing", scheduled_for: "2026-08-18", failure_reason: null },
  { payout_id: "PAY-7002", transaction_id: "TXN-9003", customer_id: "CUS-1003", status: "review required", scheduled_for: "2026-08-16", failure_reason: "compliance review" },
  { payout_id: "PAY-7003", transaction_id: "TXN-9004", customer_id: "CUS-1004", status: "failed", scheduled_for: "2026-08-15", failure_reason: "beneficiary details need review" },
];

export function seededDb() {
  return new MemoryDb({
    customers: structuredClone(customers),
    transactions: structuredClone(transactions),
    payouts: structuredClone(payouts),
  });
}

/**
 * An MCP client connected in-process to a server bound to one conversation.
 * signedInAs simulates a call started by a signed-in customer (the call-start token sets this).
 */
export async function connect(db: MemoryDb, conversationId: string | null = "conv-1", signedInAs?: string) {
  if (signedInAs && conversationId) await db.setIdentifiedCustomer(conversationId, signedInAs);
  const server = buildServer({ db, conversationId, turnIndex: 0 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: Boolean(result.isError),
      data: result.structuredContent as Record<string, unknown>,
      text: (result.content as { type: string; text: string }[])[0]?.text ?? "",
    };
  };
  return { client, call };
}
