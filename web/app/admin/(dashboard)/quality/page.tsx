import { verifyAdmin } from "@/lib/dal";
import { dateTime } from "@/lib/format";
import { adminDb } from "@/lib/supabase";

type Evaluation = { run_id: string; scenario_id: string | null; scenario: string; passed: boolean | null; notes: string | null; created_at: string };

// First sentence of the notes is the check summary; the judge's reason follows "Judge:".
function reason(notes: string | null): string {
  if (!notes) return "";
  const judge = /Judge: (.*?)(?= Model |$)/.exec(notes)?.[1];
  const failed = /^Failed checks: (.*?)\./.exec(notes)?.[1];
  return [failed ? `Checks that failed: ${failed}.` : null, judge].filter(Boolean).join(" ");
}

export default async function QualityPage() {
  await verifyAdmin();
  const { data, error } = await adminDb()
    .from("evaluations")
    .select("run_id, scenario_id, scenario, passed, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(600);
  const rows = (data ?? []) as Evaluation[];

  const runs = new Map<string, Evaluation[]>();
  for (const r of rows) runs.set(r.run_id, [...(runs.get(r.run_id) ?? []), r]);
  const [latestId, latest] = [...runs.entries()][0] ?? [null, []];
  const passed = latest.filter((r) => r.passed).length;
  const byScenario = new Map<string, Evaluation[]>();
  for (const r of latest) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Quality checks</h1>
          <p className="mt-1 text-[14px] text-muted">Scripted test conversations run through the real Iris, checked automatically.</p>
        </div>
        {latestId && (
          <a href="/admin/export/evidence" className="self-start rounded-md border border-border px-3 py-1.5 text-[14px] hover:bg-surface">Download testing evidence (CSV)</a>
        )}
      </div>

      {error && <p role="alert" className="mt-6 text-[14px] text-danger">Quality checks couldn&apos;t be loaded right now. Refresh to try again.</p>}
      {!error && !latestId && <p className="mt-6 text-[14px] text-muted">No quality checks have been run yet.</p>}

      {latestId && (
        <>
          <p className="mt-6 rounded-lg border border-border bg-surface p-4 text-[15px]">
            <span className="font-semibold">{passed} of {latest.length}</span> test conversations passed in the latest run ({dateTime(latest.at(-1)!.created_at)}).
          </p>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-surface">
            {[...byScenario.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([scenario, results]) => {
              const ok = results.filter((r) => r.passed).length;
              const allOk = ok === results.length;
              const failure = results.find((r) => !r.passed);
              return (
                <li key={scenario} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[14px] font-medium">{scenario}</p>
                    <p className={`text-[13px] font-medium ${allOk ? "text-accent" : "text-danger"}`}>{ok}/{results.length} passed</p>
                  </div>
                  {failure && <p className="mt-1 text-[13px] leading-5 text-muted">{reason(failure.notes)}</p>}
                </li>
              );
            })}
          </ul>

          <h2 className="mt-10 text-[15px] font-semibold">Earlier runs</h2>
          <ul className="mt-3 space-y-1 text-[14px] text-muted">
            {[...runs.entries()].slice(1, 11).map(([id, results]) => (
              <li key={id}>{dateTime(results.at(-1)!.created_at)}: {results.filter((r) => r.passed).length} of {results.length} passed</li>
            ))}
            {runs.size <= 1 && <li>None yet.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
