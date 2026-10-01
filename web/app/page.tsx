import Link from "next/link";
import { getSignedInCustomer } from "@/lib/customer";
import { CallPanel } from "./call-panel";
import { signOutCustomer } from "./signin/actions";

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect width="22" height="22" rx="5" fill="var(--primary)" />
        <path d="M6 15V7h5.2a2.8 2.8 0 0 1 0 5.6H8.4L13 15" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-primary">RelayPay</span>
    </div>
  );
}

export default async function Home() {
  const customer = await getSignedInCustomer().catch(() => null);
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          {customer ? (
            <div className="flex items-center gap-3 text-[13px]">
              <span className="hidden text-muted sm:inline">Signed in as <span className="font-medium text-foreground">{customer.companyName}</span></span>
              <form action={signOutCustomer}>
                <button type="submit" className="rounded-md border border-border px-3 py-1.5 hover:bg-background">Sign out</button>
              </form>
            </div>
          ) : (
            <Link href="/signin" className="rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-background">Sign in</Link>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
        <p className="mt-2 max-w-xl text-[15px] leading-6 text-muted">
          Talk to Iris, RelayPay&apos;s voice support assistant. Iris can answer questions about payments, payouts,
          invoicing and fees, check a transaction or payout, and connect you with a specialist when needed.
        </p>

        <p className="mt-4 text-[14px] text-muted">
          {customer
            ? `You're signed in as ${customer.companyName}, so Iris can go through your account with you.`
            : "Sign in to discuss your own account with Iris. General questions don't need it."}
        </p>

        <CallPanel />

        <section className="mt-8 grid gap-4 text-[14px] leading-6 text-muted sm:grid-cols-2">
          <div>
            <h2 className="font-medium text-foreground">Before you call</h2>
            <p className="mt-1">
              To go through your account, sign in first. For a specific payment, have its reference ready, for example
              TXN-9001.
            </p>
          </div>
          <div>
            <h2 className="font-medium text-foreground">About this call</h2>
            <p className="mt-1">
              Calls are transcribed and logged so our support team can follow up. Iris never asks for passwords or card
              details.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex h-12 w-full max-w-3xl items-center justify-between px-4 text-[13px] text-muted sm:px-6">
          <span>RelayPay</span>
          <Link href="/admin" className="hover:text-foreground">Staff sign-in</Link>
        </div>
      </footer>
    </div>
  );
}
