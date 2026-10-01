"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export const NAV = [
  { href: "/admin/queue", label: "Queue" },
  { href: "/admin/conversations", label: "Conversations" },
  { href: "/admin/failures", label: "Failures" },
  { href: "/admin/quality", label: "Quality checks" },
  { href: "/admin/costs", label: "Costs" },
  { href: "/admin/performance", label: "Performance" },
  { href: "/admin/settings", label: "Settings" },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {NAV.map((n) => {
        const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`block rounded-md px-3 py-2 text-[14px] ${active ? "bg-background font-medium text-primary" : "text-muted hover:bg-background hover:text-foreground"}`}
            >
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Fixed sidebar on desktop; a top bar with a menu button on small screens. */
export function Sidebar({ email, signOut }: { email: string; signOut: React.ReactNode }) {
  // Closed by tapping a link (onNavigate), so no effect is needed to follow route changes.
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex h-14 items-center px-5">
          <span className="text-[15px] font-semibold tracking-tight text-primary">RelayPay</span>
          <span className="ml-2 text-[13px] text-muted">Support</span>
        </div>
        <nav aria-label="Dashboard" className="flex-1 px-3 py-2">
          <NavLinks />
        </nav>
        <div className="border-t border-border p-4 text-[13px]">
          <p className="truncate text-muted" title={email}>{email}</p>
          <div className="mt-2">{signOut}</div>
        </div>
      </aside>

      {/* Mobile */}
      <div className="border-b border-border bg-surface md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-[15px] font-semibold tracking-tight text-primary">RelayPay <span className="font-normal text-muted">Support</span></span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="rounded-md border border-border px-3 py-1.5 text-[14px]"
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Dashboard" className="border-t border-border px-3 py-2">
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-2 border-t border-border px-3 pt-3 text-[13px]">
              <p className="truncate text-muted">{email}</p>
              <div className="mt-2">{signOut}</div>
            </div>
          </nav>
        )}
      </div>
    </>
  );
}
