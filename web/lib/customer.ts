import "server-only";
import { cache } from "react";
import { getAppUser } from "./roles";
import { adminDb, authClient } from "./supabase";

export type SignedInCustomer = { customerId: string; companyName: string; contactName: string | null; email: string };

/**
 * The customer the current visitor is signed in as, or null (design §5.2: identity comes
 * only from signing in). Only a login with the customer role counts, and it's tied to its
 * customer by ID (migration 010), so a staff login never gets customer data.
 */
export const getSignedInCustomer = cache(async (): Promise<SignedInCustomer | null> => {
  const auth = await authClient();
  const { data, error } = await auth.auth.getUser();
  const user = data.user;
  if (error || !user?.email) return null;
  const appUser = await getAppUser(user.id);
  if (appUser?.role !== "customer") return null;
  const { data: row, error: dbError } = await adminDb()
    .from("customers")
    .select("customer_id, company_name, contact_name")
    .eq("customer_id", appUser.customerId)
    .maybeSingle();
  if (dbError || !row) return null;
  return { customerId: row.customer_id, companyName: row.company_name, contactName: row.contact_name, email: user.email.toLowerCase() };
});
