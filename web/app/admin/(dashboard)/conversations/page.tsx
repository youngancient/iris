import Link from "next/link";
import { verifyAdmin } from "@/lib/dal";
import { nowMs } from "@/lib/time";
import { customerLabel, dateTime, timeAgo, type CustomerName } from "@/lib/format";
import { OUTCOME_LABEL } from "@/lib/labels";
import { adminDb } from "@/lib/supabase";

const PAGE = 50;

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await verifyAdmin();
  const params = await searchParams;
  const includeTests = params.tests === "1";
  const days = [1, 7, 30].includes(Number(params.days)) ? Number(params.days) : 7;
  const since = new Date(nowMs() - days * 86_400_000).toISOString();

  let query = adminDb()
    .from("conversations")
    .select("conversation_id, channel, caller_id, started_at, ended_at, final_status, summary, identified_customer_id, customers(company_name, contact_name)")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(PAGE);
  if (!includeTests) query = query.eq("channel", "web");
  const { data, error } = await query;
  const rows = data ?? [];

  const link = (d: number, t: boolean) => `/admin/conversations?${new URLSearchParams({ days: String(d), ...(t ? { tests: "1" } : {}) })}`;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Conversations</h1>
          <p className="mt-1 text-[14px] text-muted">Every call Iris took, newest first. Showing up to {PAGE}.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[14px]">
          {[1, 7, 30].map((d) => (
            <Link key={d} href={link(d, includeTests)} className={`rounded-md px-3 py-1.5 ${d === days ? "bg-primary text-white" : "border border-border hover:bg-surface"}`}>
              {d === 1 ? "Today" : `Last ${d} days`}
            </Link>
          ))}
          <Link href={link(days, !includeTests)} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">{includeTests ? "Hide test calls" : "Show test calls"}</Link>
        </div>
      </div>

      {error && <p role="alert" className="mt-6 text-[14px] text-danger">Conversations couldn&apos;t be loaded right now. Refresh to try again.</p>}
      {!error && rows.length === 0 && <p className="mt-6 text-[14px] text-muted">No calls in this period.</p>}

      <ul className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface">
        {rows.map((c) => (
          <li key={c.conversation_id}>
            <Link href={`/admin/conversations/${encodeURIComponent(c.conversation_id)}`} className="block p-4 hover:bg-background">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[15px] font-medium">
                  {c.identified_customer_id ? `Signed in as ${customerLabel(c.identified_customer_id, c.customers as unknown as CustomerName)}` : "Caller not signed in"}
                  {c.channel !== "web" && <span className="ml-2 rounded bg-background px-1.5 py-0.5 text-[12px] font-normal text-muted">test</span>}
                </p>
                <p className="text-[13px] text-muted" title={dateTime(c.started_at)}>
                  {c.ended_at ? OUTCOME_LABEL[c.final_status ?? ""] ?? "Finished" : "In progress or not reported"} · {timeAgo(c.started_at)}
                </p>
              </div>
              {c.summary && <p className="mt-1 line-clamp-2 text-[14px] text-muted">{c.summary}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
