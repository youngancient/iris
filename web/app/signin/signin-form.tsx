"use client";

import { useActionState } from "react";
import { signInCustomer, type CustomerSignInState } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<CustomerSignInState, FormData>(signInCustomer, { error: null });
  return (
    <form action={action} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-[14px] font-medium">Email</span>
        <input name="email" type="email" autoComplete="username" required className="mt-1 h-10 w-full rounded-md border border-border bg-surface px-3 text-[14px]" />
      </label>
      <label className="block">
        <span className="text-[14px] font-medium">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className="mt-1 h-10 w-full rounded-md border border-border bg-surface px-3 text-[14px]" />
      </label>
      {state.error && <p role="alert" className="text-[14px] text-danger">{state.error}</p>}
      <button type="submit" disabled={pending} className="h-10 w-full rounded-md bg-primary text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
