import Link from "next/link";
import { verifyAdmin } from "@/lib/dal";
import { nowMs } from "@/lib/time";
import { seconds } from "@/lib/format";
import { adminDb } from "@/lib/supabase";

const RANGES = [1, 7, 30] as const;

const SAFETY_EVENTS: Record<string, string> = {
  internal_text_blocked: "Held back a sentence repeating internal notes",
  guarantee_blocked: "Held back a sentence promising an outcome",
  ungrounded_answer: "Answered without approved knowledge (flagged for review)",
  missed_followup: "Missed a follow-up ticket (flagged)",
  tool_error_seen: "A lookup or action failed",
  mcp_unavailable: "Couldn't reach customer records",
  identity_attempts_exceeded: "Closed verification after too many failed attempts",
  identity_switch_blocked: "Blocked a caller verifying as a second customer",
  lookup_rate_limited: "Blocked a run of lookups without verification",
  cost_cap_reached: "Ended a call at the spending limit",
  call_token_invalid: "Refused a call not started from the RelayPay page",
};

function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
}

export default async function PerformancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await verifyAdmin();
  const raw = Number((await searchParams).days);
  const days = (RANGES as readonly number[]).includes(raw) ? raw : 7;
  const since = new Date(nowMs() - days * 86_400_000).toISOString();
  const db = adminDb();

  const [turns, calls, events, daily] = await Promise.all([
    db.from("conversation_turns").select("conversation_id, timings, status").gte("created_at", since).not("conversation_id", "like", "eval-%").limit(20_000),
    db.from("v_call_costs").select("duration_s, turns").eq("traffic", "real").gte("started_at", since).limit(20_000),
    db.from("v_events_daily").select("event_type, events").eq("traffic", "real").gte("day", since.slice(0, 10)),
    db.from("v_turn_daily").select("turns, turns_without_model, input_tokens, output_tokens, cache_read_tokens").eq("traffic", "real").gte("day", since.slice(0, 10)),
  ]);
  const error = turns.error || calls.error || events.error || daily.error;

  const firstWords = (turns.data ?? [])
    .map((t) => Number((t.timings as Record<string, number> | null)?.first_spoken))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const failed = (turns.data ?? []).filter((t) => t.status === "failed").length;
  const durations = (calls.data ?? []).map((c) => c.duration_s).filter((d): d is number => typeof d === "number");
  const avgCall = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;
  const avgTurns = calls.data?.length ? calls.data.reduce((s, c) => s + c.turns, 0) / calls.data.length : null;

  const safety = new Map<string, number>();
  for (const e of events.data ?? []) if (SAFETY_EVENTS[e.event_type]) safety.set(e.event_type, (safety.get(e.event_type) ?? 0) + Number(e.events));

  const totals = (daily.data ?? []).reduce(
    (t, d) => ({
      turns: t.turns + Number(d.turns), noModel: t.noModel + Number(d.turns_without_model),
      input: t.input + Number(d.input_tokens ?? 0), output: t.output + Number(d.output_tokens ?? 0), cached: t.cached + Number(d.cache_read_tokens ?? 0),
    }),
    { turns: 0, noModel: 0, input: 0, output: 0, cached: 0 },
  );
  const cacheShare = totals.input + totals.cached > 0 ? totals.cached / (totals.input + totals.cached) : null;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Performance</h1>
          <p className="mt-1 text-[14px] text-muted">How quickly Iris replies on real calls, and how often her safety checks stepped in.</p>
        </div>
        <div className="flex gap-2 text-[14px]">
          {RANGES.map((r) => (
            <Link key={r} href={`/admin/performance?days=${r}`} className={`rounded-md px-3 py-1.5 ${r === days ? "bg-primary text-white" : "border border-border hover:bg-surface"}`}>{r === 1 ? "Today" : `Last ${r} days`}</Link>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="mt-6 text-[14px] text-danger">Performance couldn&apos;t be loaded right now. Refresh to try again.</p>}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-[13px] text-muted">How fast Iris starts replying</p>
          <p className="mt-1 text-2xl font-semibold">{seconds(percentile(firstWords, 0.5))}</p>
          <p className="mt-1 text-[12px] text-muted">Typical reply. The slowest 5% took over {seconds(percentile(firstWords, 0.95))}.</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-[13px] text-muted">Average call</p>
          <p className="mt-1 text-2xl font-semibold">{avgCall != null ? `${Math.round(avgCall / 60)} min ${Math.round(avgCall % 60)} s` : "—"}</p>
          <p className="mt-1 text-[12px] text-muted">{avgTurns != null ? `About ${avgTurns.toFixed(1)} replies per call` : "No calls yet"}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-[13px] text-muted">Replies that failed</p>
          <p className="mt-1 text-2xl font-semibold">{failed}</p>
          <p className="mt-1 text-[12px] text-muted">The caller heard &quot;I&apos;m having trouble right now&quot;.</p>
        </div>
      </div>

      <section className="mt-8 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-[14px] font-medium">Safety checks that stepped in</h2>
        <ul className="mt-3 space-y-1 text-[14px]">
          {Object.entries(SAFETY_EVENTS).map(([k, label]) => (
            <li key={k} className="flex justify-between"><span className="text-muted">{label}</span><span>{safety.get(k) ?? 0}</span></li>
          ))}
        </ul>
      </section>

      <details className="mt-6 rounded-lg border border-border bg-surface p-4 text-[13px]">
        <summary className="cursor-pointer font-medium">Technical details</summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-muted">
          <dt>Replies measured</dt><dd className="text-foreground">{firstWords.length}</dd>
          <dt>Prompt served from cache</dt><dd className="text-foreground">{cacheShare != null ? `${Math.round(cacheShare * 100)}%` : "—"}</dd>
          <dt>Model tokens per reply</dt><dd className="text-foreground">{totals.turns ? Math.round((totals.input + totals.cached + totals.output) / totals.turns) : "—"}</dd>
          <dt>Replies answered without the model</dt><dd className="text-foreground">{totals.turns ? `${totals.noModel} of ${totals.turns}` : "—"}</dd>
        </dl>
      </details>
    </div>
  );
}
