import { requireAdmin } from "@/lib/dal";
import { adminDb } from "@/lib/supabase";

// The PRD testing evidence table for the latest eval run, as CSV (design §15).
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return new Response("Not authorised", { status: 401 });
  }
  const { data, error } = await adminDb()
    .from("v_testing_evidence")
    .select("test_scenario, expected_behavior, actual_behavior, result, notes, run_id");
  if (error) return new Response("Couldn't load the evidence right now.", { status: 503 });

  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Test scenario", "Expected behavior", "Actual behavior", "Pass/fail", "Notes", "Run"];
  const lines = [header.map(cell).join(","), ...(data ?? []).map((r) => [r.test_scenario, r.expected_behavior, r.actual_behavior, r.result, r.notes, r.run_id].map(cell).join(","))];
  return new Response(lines.join("\r\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="testing-evidence.csv"', "cache-control": "no-store" },
  });
}
