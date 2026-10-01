"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authClient } from "@/lib/supabase";
import { getSignedInCustomer } from "@/lib/customer";

const Credentials = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type CustomerSignInState = { error: string | null };

export async function signInCustomer(_prev: CustomerSignInState, form: FormData): Promise<CustomerSignInState> {
  const parsed = Credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  const failed = { error: "That email and password don't match a RelayPay account." };
  if (!parsed.success) return failed;

  const auth = await authClient();
  const { error } = await auth.auth.signInWithPassword({ email: parsed.data.email.toLowerCase(), password: parsed.data.password });
  if (error) return failed;
  // Signed in, but not a customer account (e.g. a staff-only login): don't treat them as one.
  if (!(await getSignedInCustomer())) {
    await auth.auth.signOut();
    return { error: "This login isn't linked to a RelayPay customer account." };
  }
  redirect("/");
}

export async function signOutCustomer() {
  const auth = await authClient();
  await auth.auth.signOut();
  redirect("/");
}
