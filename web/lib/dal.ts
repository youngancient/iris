import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { serverEnv } from "./env";
import { authClient } from "./supabase";

export type Admin = { email: string };

/**
 * The security boundary for the dashboard (design §15). Every admin page, server
 * action and route handler calls this; the proxy's redirect is only a convenience.
 * getUser() validates the session with Supabase Auth rather than trusting the cookie.
 */
export const verifyAdmin = cache(async (): Promise<Admin> => {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  const email = data.user?.email?.toLowerCase();
  if (error || !email) redirect("/admin/login");
  if (!serverEnv().adminEmails.includes(email)) redirect("/admin/login?error=not-allowed");
  return { email };
});

/** For server actions: same check, but throws instead of redirecting mid-mutation. */
export async function requireAdmin(): Promise<Admin> {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  const email = data.user?.email?.toLowerCase();
  if (error || !email || !serverEnv().adminEmails.includes(email)) throw new Error("Not authorised");
  return { email };
}
