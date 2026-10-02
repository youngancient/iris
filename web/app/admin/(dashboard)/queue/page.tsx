import Link from "next/link";
import { verifyAdmin } from "@/lib/dal";
import { customerLabel, dateTime, STATUS_LABEL, timeAgo, type CustomerName } from "@/lib/format";
import { adminDb } from "@/lib/supabase";
import { StatusForm } from "./status-form";

const LIMIT = 50;

// The bar on each row's left edge: escalations need a person, high and urgent tickets come next.
const ESCALATION_RAIL = "border-l-danger";
const ticketRail = (priority: string) => (priority === "urgent" || priority === "high" ? "border-l-warn" : "border-l-border");

type Escalation = {
  escalation_id: string; conversation_id: string | null; ticket_id: string | null; customer_id: string | null; user_name: string | null;
  user_email: string | null; category: string; reason: string; preferred_time: string | null; status: string; created_at: string; staff_note: string | null;
  customers: CustomerName;
};
type Ticket = {
  ticket_id: string; conversation_id: string | null; customer_id: string | null; transaction_id: string | null; category: string;
  priority: string; summary: string; status: string; created_at: string; staff_note: string | null;
  customers: CustomerName;
};

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await verifyAdmin();
  const params = await searchParams;
  const showClosed = params.show === "closed";
  const includeTests = params.tests === "1";
  const statuses = showClosed ? ["closed"] : ["open", "in progress"];

  const db = adminDb();
  let escQuery = db
    .from("escalations")
    .select("escalation_id, conversation_id, ticket_id, customer_id, user_name, user_email, category, reason, preferred_time, status, created_at, staff_note, customers(company_name, contact_name)")
    .in("status", statuses).order("created_at", { ascending: false }).limit(LIMIT);
  let ticketQuery = db
    .from("support_tickets")
    .select("ticket_id, conversation_id, customer_id, transaction_id, category, priority, summary, status, created_at, staff_note, customers(company_name, contact_name)")
    .in("status", statuses).order("created_at", { ascending: false }).limit(LIMIT);
  // Test (eval) conversations are hidden unless asked for.
  if (!includeTests) {
    // NULL conversation IDs must stay visible: `not like` alone would drop them.
    const notTest = "conversation_id.is.null,conversation_id.not.like.eval-*";
    escQuery = escQuery.or(notTest);
    ticketQuery = ticketQuery.or(notTest);
  }
  const [esc, tickets] = await Promise.all([escQuery, ticketQuery]);
  // A many-to-one embed is one object at runtime; the untyped client types it as an array.
  const escalations = (esc.data ?? []) as unknown as Escalation[];
  const ticketRows = (tickets.data ?? []) as unknown as Ticket[];
  const failed = esc.error || tickets.error;

  const tab = (label: string, href: string, active: boolean) => (
    <Link href={href} className={`rounded-md px-3 py-1.5 text-[14px] ${active ? "bg-primary text-white" : "border border-border hover:bg-surface"}`}>{label}</Link>
  );
  const q = (show: boolean, tests: boolean) => `/admin/queue?${new URLSearchParams({ ...(show ? { show: "closed" } : {}), ...(tests ? { tests: "1" } : {}) })}`;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Queue</h1>
          <p className="mt-1 text-[14px] text-muted">Callers Iris handed to the team. Newest first.</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            <span className="flex items-center gap-1.5"><span className="h-3 w-1 rounded-full bg-danger" aria-hidden="true" />Specialist callback</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-1 rounded-full bg-warn" aria-hidden="true" />High or urgent ticket</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tab("Needs attention", q(false, includeTests), !showClosed)}
          {tab("Closed", q(true, includeTests), showClosed)}
          {tab(includeTests ? "Hide test calls" : "Show test calls", q(showClosed, !includeTests), false)}
        </div>
      </div>

      {failed && <p role="alert" className="mt-6 text-[14px] text-danger">The queue couldn&apos;t be loaded right now. Refresh to try again.</p>}

      <section className="mt-8">
        <h2 className="text-[15px] font-semibold">Specialist callbacks ({escalations.length})</h2>
        {escalations.length === 0 && <p className="mt-2 text-[14px] text-muted">Nothing here.</p>}
        <ul className="mt-3 space-y-3">
          {escalations.map((e) => (
            <li key={e.escalation_id} className={`rounded-lg border border-l-4 border-border bg-surface p-4 ${ESCALATION_RAIL}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[15px] font-medium">{e.user_name ?? "Unknown caller"} <span className="font-normal text-muted">· {e.category}</span></p>
                <p className="text-[13px] text-muted" title={dateTime(e.created_at)}>{STATUS_LABEL[e.status] ?? e.status} · {timeAgo(e.created_at)}</p>
              </div>
              <p className="mt-1 text-[14px]">{e.reason}</p>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] text-muted sm:grid-cols-3">
                <div><dt className="inline">Email: </dt><dd className="inline text-foreground">{e.user_email ?? "—"}</dd></div>
                <div><dt className="inline">Callback: </dt><dd className="inline text-foreground">{e.preferred_time || "No time given"}</dd></div>
                <div><dt className="inline">Account: </dt><dd className="inline text-foreground">{e.customer_id ? customerLabel(e.customer_id, e.customers) : "Caller not signed in"}</dd></div>
              </dl>
              <p className="mt-2 text-[13px] text-muted">
                {e.escalation_id}{e.ticket_id ? ` · ticket ${e.ticket_id}` : ""}
                {e.conversation_id && (<> · <Link className="text-primary underline" href={`/admin/conversations/${encodeURIComponent(e.conversation_id)}`}>See the call</Link></>)}
              </p>
              <StatusForm kind="escalation" id={e.escalation_id} status={e.status} note={e.staff_note} />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold">Support tickets ({ticketRows.length})</h2>
        {ticketRows.length === 0 && <p className="mt-2 text-[14px] text-muted">Nothing here.</p>}
        <ul className="mt-3 space-y-3">
          {ticketRows.map((t) => (
            <li key={t.ticket_id} className={`rounded-lg border border-l-4 border-border bg-surface p-4 ${ticketRail(t.priority)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[15px] font-medium capitalize">{t.category} <span className="font-normal normal-case text-muted">· {t.priority} priority</span></p>
                <p className="text-[13px] text-muted" title={dateTime(t.created_at)}>{STATUS_LABEL[t.status] ?? t.status} · {timeAgo(t.created_at)}</p>
              </div>
              <p className="mt-1 text-[14px]">{t.summary}</p>
              <p className="mt-2 text-[13px] text-muted">
                {t.ticket_id} · {t.customer_id ? customerLabel(t.customer_id, t.customers) : "Caller not signed in"}{t.transaction_id ? ` · ${t.transaction_id}` : ""}
                {t.conversation_id && (<> · <Link className="text-primary underline" href={`/admin/conversations/${encodeURIComponent(t.conversation_id)}`}>See the call</Link></>)}
              </p>
              <StatusForm kind="ticket" id={t.ticket_id} status={t.status} note={t.staff_note} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
