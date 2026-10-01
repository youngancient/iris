import Link from "next/link";
import { verifyAdmin } from "@/lib/dal";
import { dateTime, money } from "@/lib/format";
import { OUTCOME_LABEL } from "@/lib/labels";
import { EST_TOKENS_PER_QUERY, VOYAGE_USD_PER_MILLION_TOKENS } from "@/lib/pricing";
import { adminDb } from "@/lib/supabase";
import { DailyChart, type Day } from "./daily-chart";

type CallCost = {
  conversation_id: string; started_at: string; final_status: string | null; traffic: string;
  model_cost_usd: number; vapi_cost_usd: number; total_cost_usd: number; turns: number; duration_s: number | null;
};

const RANGES = [7, 30, 90] as const;
const TRAFFIC_LABEL: Record<string, string> = { real: "Real calls", eval: "Quality checks", canary: "Health checks" };

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-1 text-[12px] text-muted">{note}</p>}
    </div>
  );
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await verifyAdmin();
  const days = RANGES.includes(Number((await searchParams).days) as 7) ? Number((await searchParams).days) : 30;
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const db = adminDb();
  const cols = "conversation_id, started_at, final_status, traffic, model_cost_usd, vapi_cost_usd, total_cost_usd, turns, duration_s";
  const [inRange, allTime, month, retrievals] = await Promise.all([
    db.from("v_call_costs").select(cols).gte("started_at", since.toISOString()).order("started_at").limit(10_000),
    db.from("v_call_costs").select("total_cost_usd").limit(100_000),
    db.from("v_call_costs").select("total_cost_usd").gte("started_at", monthStart.toISOString()).limit(100_000),
    db.from("retrieval_logs").select("*", { count: "exact", head: true }).gte("created_at", since.toISOString()),
  ]);
  const error = inRange.error || allTime.error || month.error;
  const calls = ((inRange.data ?? []) as CallCost[]).map((c) => ({ ...c, model_cost_usd: Number(c.model_cost_usd), vapi_cost_usd: Number(c.vapi_cost_usd), total_cost_usd: Number(c.total_cost_usd) }));
  const sum = (xs: { total_cost_usd: number | string }[]) => xs.reduce((s, x) => s + Number(x.total_cost_usd), 0);

  const embeddings = ((retrievals.count ?? 0) * EST_TOKENS_PER_QUERY * VOYAGE_USD_PER_MILLION_TOKENS) / 1_000_000;
  const rangeTotal = sum(calls) + embeddings;
  const monthTotal = sum((month.data ?? []) as { total_cost_usd: number }[]);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projection = (monthTotal / Math.max(1, now.getUTCDate())) * daysInMonth;
  const claude = calls.reduce((s, c) => s + c.model_cost_usd, 0);
  const vapi = calls.reduce((s, c) => s + c.vapi_cost_usd, 0);

  const byTraffic = new Map<string, number>();
  for (const c of calls) byTraffic.set(c.traffic, (byTraffic.get(c.traffic) ?? 0) + c.total_cost_usd);

  const real = calls.filter((c) => c.traffic === "real");
  const minutes = real.reduce((s, c) => s + (c.duration_s ?? 0), 0) / 60;
  const turns = real.reduce((s, c) => s + c.turns, 0);
  const realTotal = real.reduce((s, c) => s + c.total_cost_usd, 0);
  const sortedCosts = real.map((c) => c.total_cost_usd).sort((a, b) => a - b);
  const pct = (p: number) => (sortedCosts.length ? sortedCosts[Math.min(sortedCosts.length - 1, Math.floor(p * sortedCosts.length))] : null);

  const outcomes = new Map<string, { n: number; cost: number }>();
  for (const c of real) {
    const k = c.final_status ?? "unknown";
    const o = outcomes.get(k) ?? { n: 0, cost: 0 };
    outcomes.set(k, { n: o.n + 1, cost: o.cost + c.total_cost_usd });
  }

  const dayMap = new Map<string, Day>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    dayMap.set(d, { day: d, claude: 0, vapi: 0 });
  }
  for (const c of calls) {
    const d = dayMap.get(c.started_at.slice(0, 10));
    if (d) {
      d.claude += c.model_cost_usd;
      d.vapi += c.vapi_cost_usd;
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Costs</h1>
          <p className="mt-1 text-[14px] text-muted">What Iris costs to run, in US dollars.</p>
        </div>
        <div className="flex gap-2 text-[14px]">
          {RANGES.map((r) => (
            <Link key={r} href={`/admin/costs?days=${r}`} className={`rounded-md px-3 py-1.5 ${r === days ? "bg-primary text-white" : "border border-border hover:bg-surface"}`}>Last {r} days</Link>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="mt-6 text-[14px] text-danger">Costs couldn&apos;t be loaded right now. Refresh to try again.</p>}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total cost, all time" value={money(sum((allTime.data ?? []) as { total_cost_usd: number }[]))} />
        <Tile label={`Total cost, last ${days} days`} value={money(rangeTotal)} note={`Claude ${money(claude)} · Vapi ${money(vapi)} · search ${embeddings < 0.01 ? "under $0.01" : money(embeddings)}`} />
        <Tile label="This month so far" value={money(monthTotal)} />
        <Tile label="Projected this month" value={money(projection)} note="At this month's rate so far" />
      </div>

      <div className="mt-6"><DailyChart days={[...dayMap.values()]} /></div>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-[14px] font-medium">Where the money went</h2>
          <ul className="mt-3 space-y-1 text-[14px]">
            {[...byTraffic.entries()].map(([k, v]) => (
              <li key={k} className="flex justify-between"><span className="text-muted">{TRAFFIC_LABEL[k] ?? k}</span><span>{money(v)}</span></li>
            ))}
            {byTraffic.size === 0 && <li className="text-muted">No calls in this period.</li>}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-[14px] font-medium">Real calls</h2>
          <ul className="mt-3 space-y-1 text-[14px]">
            <li className="flex justify-between"><span className="text-muted">Average cost per call</span><span>{real.length ? money(realTotal / real.length, 3) : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Average cost per minute</span><span>{minutes > 0 ? money(realTotal / minutes, 3) : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Average cost per reply</span><span>{turns ? money(realTotal / turns, 4) : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Typical call / most expensive 5%</span><span>{money(pct(0.5), 3)} / {money(pct(0.95), 3)}</span></li>
          </ul>
          <h3 className="mt-4 text-[13px] font-medium text-muted">Average cost by how the call ended</h3>
          <ul className="mt-1 space-y-1 text-[14px]">
            {[...outcomes.entries()].map(([k, o]) => (
              <li key={k} className="flex justify-between"><span className="text-muted">{OUTCOME_LABEL[k] ?? "Not reported"} ({o.n})</span><span>{money(o.cost / o.n, 3)}</span></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-[14px] font-medium">Most expensive calls</h2>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface text-[14px]">
          {[...calls].sort((a, b) => b.total_cost_usd - a.total_cost_usd).slice(0, 20).map((c) => (
            <li key={c.conversation_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <Link className="text-primary underline" href={`/admin/conversations/${encodeURIComponent(c.conversation_id)}`}>{dateTime(c.started_at)}</Link>
              <span className="text-muted">{TRAFFIC_LABEL[c.traffic] ?? c.traffic} · {c.turns} replies</span>
              <span>{money(c.total_cost_usd, 3)}</span>
            </li>
          ))}
          {calls.length === 0 && <li className="p-3 text-muted">No calls in this period.</li>}
        </ul>
      </section>
    </div>
  );
}
