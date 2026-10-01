import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAppUser } from "./roles";
import { authClient } from "./supabase";

export type Admin = { email: string; userId: string };

/** The signed-in staff member, or null. getUser() checks the session with Supabase Auth. */
async function currentStaff(): Promise<Admin | null> {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error || !user?.email) return null;
  const appUser = await getAppUser(user.id);
  return appUser?.role === "staff" ? { email: user.email.toLowerCase(), userId: user.id } : null;
}

/**
 * The security boundary for the dashboard (design §15). Every admin page calls this;
 * the proxy's redirect is only a convenience. Only logins with the staff role get in.
 */
export const verifyAdmin = cache(async (): Promise<Admin> => {
  const staff = await currentStaff();
  if (!staff) redirect("/admin/login?error=not-allowed");
  return staff;
});

/** For server actions and route handlers: same check, but throws instead of redirecting. */
export async function requireAdmin(): Promise<Admin> {
  const staff = await currentStaff();
  if (!staff) throw new Error("Not authorised");
  return staff;
}

/** True if the current session belongs to a staff login (used to sign wrong-role logins out). */
export async function isStaffSession(): Promise<boolean> {
  return (await currentStaff()) !== null;
}
