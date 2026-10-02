"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/dal";
import { adminDb, passwordChecker } from "@/lib/supabase";

const Input = z.object({
  turnOn: z.enum(["true", "false"]).transform((v) => v === "true"),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters).").max(500),
  password: z.string().min(1, "Enter your password.").max(200),
});

export type KillSwitchResult = { ok: boolean; message: string };

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export async function setKillSwitch(_prev: KillSwitchResult | null, form: FormData): Promise<KillSwitchResult> {
  // Anything thrown here would replace the dashboard with Next's generic error page, so it's
  // logged and turned into a message the dialog can show.
  try {
    return await changeKillSwitch(form);
  } catch (err) {
    console.error("kill switch action failed", err);
    if (err instanceof Error && err.message === "Not authorised") {
      return { ok: false, message: "Your session has expired. Sign in again, then retry." };
    }
    return { ok: false, message: "The switch couldn't be changed right now. Try again in a moment." };
  }
}

async function changeKillSwitch(form: FormData): Promise<KillSwitchResult> {
  const admin = await requireAdmin();
  const parsed = Input.safeParse({ turnOn: form.get("turnOn"), reason: form.get("reason"), password: form.get("password") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  const { turnOn, reason, password } = parsed.data;
  const db = adminDb();

  // 5 wrong passwords lock the switch for this admin for 15 minutes (design §15).
  const { count } = await db
    .from("admin_actions")
    .select("*", { count: "exact", head: true })
    .eq("admin_email", admin.email)
    .eq("action", "reauth_failed")
    .gte("created_at", new Date(Date.now() - LOCKOUT_MS).toISOString());
  if ((count ?? 0) >= LOCKOUT_ATTEMPTS) {
    return { ok: false, message: "Too many wrong passwords. The switch is locked for you for 15 minutes." };
  }

  // Re-check the password for the signed-in admin's own email, never one sent from the
  // browser, using a client that doesn't touch this session's cookies.
  const checker = passwordChecker();
  const { error: authError } = await checker.auth.signInWithPassword({ email: admin.email, password });
  if (authError) {
    await db.from("admin_actions").insert({ admin_email: admin.email, action: "reauth_failed", after_value: "kill_switch" });
    return { ok: false, message: "That password isn't right." };
  }
  // "local" ends only the session this check just created. The default ("global") revokes every
  // session for the user, which signed the admin out of the dashboard too.
  await checker.auth.signOut({ scope: "local" }).catch(() => {});

  // Conditional on the state the admin saw, so two people can't flip it past each other.
  const { data, error } = await db
    .from("app_settings")
    .update({ maintenance: turnOn, updated_at: new Date().toISOString(), updated_by: admin.email })
    .eq("id", true)
    .eq("maintenance", !turnOn)
    .select("maintenance");
  if (error) return { ok: false, message: "The switch couldn't be changed right now. Try again in a moment." };
  if (!data || data.length === 0) return { ok: false, message: "Someone else just changed this. Refresh to see the current state." };

  await db.from("admin_actions").insert({
    admin_email: admin.email, action: turnOn ? "kill_switch_on" : "kill_switch_off",
    before_value: String(!turnOn), after_value: String(turnOn), reason,
  });
  revalidatePath("/admin", "layout");
  return { ok: true, message: turnOn ? "Iris is stopped. Callers now hear the unavailable message." : "Iris is back on." };
}
