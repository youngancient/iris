import Link from "next/link";
import { SignInForm } from "./signin-form";

export default function SignInPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <Link href="/" className="text-[15px] font-semibold tracking-tight text-primary">RelayPay</Link>
      <h1 className="mt-4 text-xl font-semibold">Sign in to RelayPay support</h1>
      <p className="mt-1 text-[14px] leading-6 text-muted">
        Signing in lets Iris go through your account with you. You can still ask general questions without signing in.
      </p>
      <SignInForm />
    </main>
  );
}
