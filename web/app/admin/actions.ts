"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { authClient } from "@/lib/supabase";

const Credentials = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type SignInState = { error: string | null };

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const parsed = Credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  // One message for every failure, so the form never reveals which staff emails exist.
  const failed = { error: "That email and password don't match a staff account." };
  if (!parsed.success) return failed;

  const email = parsed.data.email.toLowerCase();
  if (!serverEnv().adminEmails.includes(email)) return failed;

  const supabase = await authClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (error) return failed;
  redirect("/admin/queue");
}

export async function signOut() {
  const supabase = await authClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}
