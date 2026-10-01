import "server-only";
import { adminDb } from "./supabase";

export type AppUser = { role: "staff" } | { role: "customer"; customerId: string };

/**
 * The single source of truth for who may use which side (migration 010). One role per
 * login, keyed by the Supabase Auth user ID; only server code can read or write it.
 */
export async function getAppUser(userId: string): Promise<AppUser | null> {
  const { data, error } = await adminDb().from("app_users").select("role, customer_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`app_users: ${error.message}`);
  if (!data) return null;
  if (data.role === "staff") return { role: "staff" };
  if (data.role === "customer" && data.customer_id) return { role: "customer", customerId: data.customer_id };
  return null;
}
