import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import type { CustomerRow } from "../db/types.js";
import { normalizeCompany, normalizeEmail, normalizeRef, present } from "../lib/normalize.js";
import { withToolLogging } from "../lib/withToolLogging.js";
import { identitySwitchBlocked } from "./limits.js";

const description =
  "Use this tool when the user provides enough safe identifying information to find a customer record. " +
  "Accepts customer_id, email and company_name. Account details (plan, account_status, kyc_status, support_notes) " +
  "are only returned when the caller is signed in on the RelayPay page as that customer; otherwise they come back " +
  "empty and the caller must sign in to discuss their account. support_notes is internal guidance: act on it, never read it aloud.";

const inputSchema = {
  customer_id: z.string().optional(),
  email: z.string().optional(),
  company_name: z.string().optional(),
};

const outputSchema = {
  found: z.boolean(),
  customer_id: z.string(),
  company_name: z.string(),
  plan: z.string(),
  account_status: z.string(),
  kyc_status: z.string(),
  support_notes: z.string(),
};

type Output = { [K in keyof typeof outputSchema]: K extends "found" ? boolean : string };

const notFound: Output = {
  found: false, customer_id: "", company_name: "", plan: "", account_status: "", kyc_status: "", support_notes: "",
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "lookup_customer",
    { description, inputSchema, outputSchema },
    withToolLogging(
      ctx,
      { name: "lookup_customer", purpose: description, failureMessage: "Customer lookup is temporarily unavailable. Please try again shortly." },
      async (input: { customer_id?: string; email?: string; company_name?: string }) => {
        const customerId = present(input.customer_id) && normalizeRef(input.customer_id!, "CUS");
        const email = present(input.email) && normalizeEmail(input.email!);
        const company = present(input.company_name) && normalizeCompany(input.company_name!);

        if (!customerId && !email && !company) {
          return { status: "invalid", message: "Provide at least one of customer_id, email or company_name." };
        }

        // Every identifier given must point at the same single customer.
        const [byId, byEmail, byCompany] = await Promise.all([
          customerId ? ctx.db.customerById(customerId).then((c) => (c ? [c] : [])) : null,
          email ? ctx.db.customersByEmail(email) : null,
          company ? ctx.db.customersByCompany(company) : null,
        ]);
        const candidateSets: CustomerRow[][] = [byId, byEmail, byCompany].filter((set): set is CustomerRow[] => set !== null);
        const ids = candidateSets.map((set) => set.map((c) => c.customer_id));
        const shared = ids.reduce((acc, set) => acc.filter((id) => set.includes(id)));
        if (shared.length !== 1) return { status: "not_found", data: notFound };
        const customer = candidateSets[0].find((c) => c.customer_id === shared[0])!;

        // Identity comes only from signing in on the RelayPay page (design §5.2): the call-start
        // token sets it server-side. Nothing a caller says can unlock account details.
        const signedInAs = ctx.conversationId ? await ctx.db.identifiedCustomer(ctx.conversationId) : null;
        if (signedInAs && signedInAs !== customer.customer_id) {
          // Signed in as one customer, asking about another: reveal nothing (identity lock).
          await identitySwitchBlocked(ctx, signedInAs, customer.customer_id);
          return { status: "not_found", data: notFound };
        }
        if (signedInAs !== customer.customer_id) {
          return {
            status: "success",
            data: { ...notFound, found: true, customer_id: customer.customer_id, company_name: customer.company_name },
          };
        }

        const data: Output = {
          found: true,
          customer_id: customer.customer_id,
          company_name: customer.company_name,
          plan: customer.plan ?? "",
          account_status: customer.account_status ?? "",
          kyc_status: customer.kyc_status ?? "",
          support_notes: customer.support_notes ?? "",
        };
        return { status: "success", data };
      },
    ),
  );
}
