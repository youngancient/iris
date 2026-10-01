"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isStaffSession } from "@/lib/dal";
import { authClient } from "@/lib/supabase";

const Credentials = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type SignInState = { error: string | null };

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const parsed = Credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  // One message for every failure, so the form never reveals which staff emails exist.
  const failed = { error: "That email and password don't match a staff account." };
  if (!parsed.success) return failed;

  const supabase = await authClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email.toLowerCase(), password: parsed.data.password });
  if (error) return failed;
  // A valid login without the staff role (e.g. a customer) is signed straight back out.
  if (!(await isStaffSession())) {
    await supabase.auth.signOut();
    return failed;
  }
  redirect("/admin/queue");
}

export async function signOut() {
  const supabase = await authClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}
