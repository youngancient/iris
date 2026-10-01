import Link from "next/link";
import { verifyAdmin } from "@/lib/dal";
import { nowMs } from "@/lib/time";
import { dateTime, timeAgo } from "@/lib/format";
import { adminDb } from "@/lib/supabase";
import { acknowledge } from "./actions";
import { describeFailure, SEVERITY_STYLE } from "./describe";

type Failure = { created_at: string; kind: string; conversation_id: string | null; source: string; detail: string | null };

export default async function FailuresPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await verifyAdmin();
  const includeTests = (await searchParams).tests === "1";
  const db = adminDb();
  const [failures, acks] = await Promise.all([
    db.from("v_failures").select("created_at, kind, conversation_id, source, detail").order("created_at", { ascending: false }).limit(200),
    db.from("failure_acks").select("kind, conversation_id, occurred_at, acked_by").gte("occurred_at", new Date(nowMs() - 86_400_000).toISOString()),
  ]);
  const acked = new Map((acks.data ?? []).map((a) => [`${a.kind}|${a.conversation_id}|${Date.parse(a.occurred_at)}`, a.acked_by as string]));
  const rows = ((failures.data ?? []) as Failure[]).filter((f) => includeTests || !f.conversation_id?.startsWith("eval-"));
  const severityOrder = { red: 0, amber: 1, grey: 2 };
  const described = rows
    .map((f) => ({ ...f, ...describeFailure(f.kind, f.source), ackedBy: acked.get(`${f.kind}|${f.conversation_id ?? ""}|${Date.parse(f.created_at)}`) }))
    .sort((a, b) => Number(Boolean(a.ackedBy)) - Number(Boolean(b.ackedBy)) || severityOrder[a.severity] - severityOrder[b.severity]);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Failures</h1>
          <p className="mt-1 text-[14px] text-muted">What went wrong in the last 24 hours. The same list is posted to the team&apos;s alerts channel.</p>
        </div>
        <Link href={includeTests ? "/admin/failures" : "/admin/failures?tests=1"} className="self-start rounded-md border border-border px-3 py-1.5 text-[14px] hover:bg-surface">
          {includeTests ? "Hide test calls" : "Show test calls"}
        </Link>
      </div>

      {failures.error && <p role="alert" className="mt-6 text-[14px] text-danger">Failures couldn&apos;t be loaded right now. Refresh to try again.</p>}
      {!failures.error && described.length === 0 && <p className="mt-6 rounded-lg border border-border bg-surface p-4 text-[14px]">Nothing has gone wrong in the last 24 hours.</p>}

      <ul className="mt-6 space-y-3">
        {described.map((f, i) => (
          <li key={i} className={`rounded-lg border border-border bg-surface p-4 ${f.ackedBy ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                <span className={`h-2.5 w-2.5 rounded-full ${SEVERITY_STYLE[f.severity].dot}`} aria-hidden="true" />
                {SEVERITY_STYLE[f.severity].label}
              </p>
              <p className="text-[13px] text-muted" title={dateTime(f.created_at)}>{timeAgo(f.created_at)}</p>
            </div>
            <p className="mt-2 text-[14px] leading-6">{f.text}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
              {f.conversation_id && (
                <Link className="text-primary underline" href={`/admin/conversations/${encodeURIComponent(f.conversation_id)}`}>See the call</Link>
              )}
              {f.ackedBy ? (
                <span className="text-muted">Acknowledged by {f.ackedBy}</span>
              ) : (
                <form action={acknowledge}>
                  <input type="hidden" name="kind" value={f.kind} />
                  <input type="hidden" name="conversationId" value={f.conversation_id ?? ""} />
                  <input type="hidden" name="occurredAt" value={f.created_at} />
                  <button type="submit" className="rounded-md border border-border px-3 py-1 hover:bg-background">Acknowledge</button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
