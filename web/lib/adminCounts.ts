import "server-only";
import { adminDb } from "./supabase";
import { nowMs } from "./time";

// Counts for the dashboard sidebar. Same filters as the Queue and Failures pages
// (test calls hidden, failures acknowledged by someone don't count), so the numbers match.

export type AdminCounts = { queue: number; failures: number };

const NOT_TEST = "conversation_id.is.null,conversation_id.not.like.eval-*";

export async function getAdminCounts(): Promise<AdminCounts | null> {
  const db = adminDb();
  const open = ["open", "in progress"];
  const [esc, tickets, failures, acks] = await Promise.all([
    db.from("escalations").select("*", { count: "exact", head: true }).in("status", open).or(NOT_TEST),
    db.from("support_tickets").select("*", { count: "exact", head: true }).in("status", open).or(NOT_TEST),
    db.from("v_failures").select("created_at, kind, conversation_id").or(NOT_TEST).limit(200),
    db.from("failure_acks").select("kind, conversation_id, occurred_at").gte("occurred_at", new Date(nowMs() - 86_400_000).toISOString()),
  ]);
  if (esc.error || tickets.error || failures.error || acks.error) return null;
  const acked = new Set((acks.data ?? []).map((a) => `${a.kind}|${a.conversation_id ?? ""}|${Date.parse(a.occurred_at)}`));
  const unacked = (failures.data ?? []).filter((f) => !acked.has(`${f.kind}|${f.conversation_id ?? ""}|${Date.parse(f.created_at)}`));
  return { queue: (esc.count ?? 0) + (tickets.count ?? 0), failures: unacked.length };
}
