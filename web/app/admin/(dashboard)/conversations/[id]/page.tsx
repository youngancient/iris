import Link from "next/link";
import { notFound } from "next/navigation";
import { verifyAdmin } from "@/lib/dal";
import { dateTime, money, seconds } from "@/lib/format";
import { ANSWER_LABEL, eventLabel, HIDDEN_EVENTS, OUTCOME_LABEL, toolLabel } from "@/lib/labels";
import { adminDb } from "@/lib/supabase";

type Entry =
  | { at: string; kind: "turn"; turn: number; user: string | null; iris: string | null; answer: string | null; timings: Record<string, number> | null; cost: number | null }
  | { at: string; kind: "note"; text: string; tone: "info" | "warn" }
  | { at: string; kind: "tech"; text: string };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  await verifyAdmin();
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) notFound();

  const db = adminDb();
  const by = (table: string, cols: string) => db.from(table).select(cols).eq("conversation_id", id).order("created_at").limit(500);
  const [convo, turns, tools, events, retrievals] = await Promise.all([
    db.from("conversations").select("*").eq("conversation_id", id).maybeSingle(),
    by("conversation_turns", "created_at, turn_index, user_transcript, assistant_response, answer_type, timings, cost_usd"),
    by("tool_calls", "created_at, tool_name, status, input_summary, result_summary, duration_ms"),
    by("conversation_events", "created_at, event_type"),
    by("retrieval_logs", "created_at, source_titles, matched, method"),
  ]);
  if (convo.error) return <p role="alert" className="text-[14px] text-danger">This call couldn&apos;t be loaded right now. Refresh to try again.</p>;
  if (!convo.data) notFound();
  const c = convo.data;

  type Row = Record<string, unknown>;
  const entries: Entry[] = [
    ...((turns.data ?? []) as unknown as Row[]).map((t) => ({
      at: t.created_at as string, kind: "turn" as const, turn: t.turn_index as number, user: t.user_transcript as string | null,
      iris: t.assistant_response as string | null, answer: t.answer_type as string | null,
      timings: t.timings as Record<string, number> | null, cost: t.cost_usd as number | null,
    })),
    ...((tools.data ?? []) as unknown as Row[])
      .filter((t) => t.tool_name !== "log_conversation_event")
      .map((t) => ({
        at: t.created_at as string, kind: "note" as const, tone: t.status === "error" ? ("warn" as const) : ("info" as const),
        text: toolLabel(t.tool_name as string, t.input_summary as Row | null, t.result_summary as Row | null, t.status as string),
      })),
    ...((events.data ?? []) as unknown as Row[])
      .filter((e) => !HIDDEN_EVENTS.has(e.event_type as string))
      .map((e) => ({
        at: e.created_at as string, kind: "note" as const,
        tone: /blocked|missed|unavailable|error|ungrounded|exceeded|limited|failed/.test(e.event_type as string) ? ("warn" as const) : ("info" as const),
        text: eventLabel(e.event_type as string),
      })),
    ...((retrievals.data ?? []) as unknown as Row[]).map((r) => ({
      at: r.created_at as string, kind: "tech" as const,
      text: r.matched ? `Checked the knowledge base: ${(r.source_titles as string[]).join(", ")}` : "Checked the knowledge base: nothing relevant",
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const turnRows = entries.filter((e): e is Extract<Entry, { kind: "turn" }> => e.kind === "turn");
  const totalCost = turnRows.reduce((s, t) => s + Number(t.cost ?? 0), 0);

  return (
    <div className="max-w-3xl">
      <Link href="/admin/conversations" className="text-[14px] text-primary underline">← All conversations</Link>
      <h1 className="mt-3 text-xl font-semibold">Call on {dateTime(c.started_at)}</h1>
      <p className="mt-1 text-[14px] text-muted">
        {c.identified_customer_id ? `Verified as ${c.identified_customer_id}` : "Caller not verified"} ·{" "}
        {c.ended_at ? OUTCOME_LABEL[c.final_status ?? ""] ?? "Finished" : "In progress or not reported"}
        {c.channel !== "web" && " · test call"}
      </p>
      {c.summary && <p className="mt-4 rounded-lg border border-border bg-surface p-4 text-[14px] leading-6">{c.summary}</p>}

      <ol className="mt-6 space-y-3">
        {entries.filter((e) => e.kind !== "tech").map((e, i) =>
          e.kind === "turn" ? (
            <li key={i} className="space-y-2">
              {e.user && (
                <div className="text-[14px] leading-6"><span className="mr-2 font-medium text-muted">Caller</span>{e.user}</div>
              )}
              {e.iris && (
                <div className="text-[14px] leading-6">
                  <span className="mr-2 font-medium text-primary">Iris</span>{e.iris}
                  {e.answer && <span className="ml-2 text-[12px] text-muted">({ANSWER_LABEL[e.answer] ?? e.answer})</span>}
                </div>
              )}
            </li>
          ) : (
            <li key={i} className={`border-l-2 pl-3 text-[13px] ${e.tone === "warn" ? "border-danger text-danger" : "border-accent text-muted"}`}>{e.text}</li>
          ),
        )}
      </ol>

      <details className="mt-8 rounded-lg border border-border bg-surface p-4 text-[13px]">
        <summary className="cursor-pointer font-medium">Technical details</summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-muted">
          <dt>Call reference</dt><dd className="break-all text-foreground">{c.conversation_id}</dd>
          <dt>Model cost</dt><dd className="text-foreground">{money(totalCost, 4)}</dd>
          <dt>Vapi cost</dt><dd className="text-foreground">{money(c.vapi_cost_usd as number | null, 4)}</dd>
          <dt>Call length</dt><dd className="text-foreground">{c.duration_s != null ? `${c.duration_s}s` : "—"}</dd>
        </dl>
        <ul className="mt-3 space-y-1 text-muted">
          {entries.filter((e) => e.kind === "tech").map((e, i) => <li key={i}>{(e as { text: string }).text}</li>)}
          {turnRows.map((t) => (
            <li key={`t${t.turn}`}>Turn {t.turn}: first words after {seconds(t.timings?.first_spoken)}, whole reply {seconds(t.timings?.total)}, cost {money(t.cost, 4)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
