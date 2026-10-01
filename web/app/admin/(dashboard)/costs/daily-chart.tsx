// Stacked daily spend: Claude and Vapi. Palette validated with the dataviz checks
// (lightness, chroma, colour-blind separation) against the light surface.
export const SERIES = [
  { key: "claude", label: "Claude (AI model)", color: "#2f63b8" },
  { key: "vapi", label: "Vapi (voice and phone line)", color: "#1b9aa8" },
] as const;

export type Day = { day: string; claude: number; vapi: number };

const fmt = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function DailyChart({ days }: { days: Day[] }) {
  const max = Math.max(0.0001, ...days.map((d) => d.claude + d.vapi));
  return (
    <figure className="rounded-lg border border-border bg-surface p-4">
      <figcaption className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[14px] font-medium">Spend per day</span>
        <span className="flex flex-wrap gap-4 text-[13px] text-muted">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>

      <div className="mt-4 flex h-40 items-end gap-1 border-b border-border" role="img" aria-label="Spend per day, stacked by provider. The numbers are in the table below.">
        {days.map((d) => {
          const total = d.claude + d.vapi;
          return (
            <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
              {/* Hover tooltip: the day's figures, in text ink. */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-max -translate-x-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-sm group-hover:block">
                <p className="font-medium">{label(d.day)}: {fmt(total)}</p>
                <p className="text-muted">Claude {fmt(d.claude)} · Vapi {fmt(d.vapi)}</p>
              </div>
              {total > 0 && (
                <div className="flex flex-col gap-[2px]" style={{ height: `${(total / max) * 100}%` }}>
                  {d.vapi > 0 && <div className="rounded-t-[4px]" style={{ background: SERIES[1].color, flexGrow: d.vapi }} />}
                  {d.claude > 0 && <div className={d.vapi > 0 ? "" : "rounded-t-[4px]"} style={{ background: SERIES[0].color, flexGrow: d.claude, minHeight: 2 }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[12px] text-muted">
        <span>{days[0] ? label(days[0].day) : ""}</span>
        <span>{days.at(-1) ? label(days.at(-1)!.day) : ""}</span>
      </div>

      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer text-muted">See the numbers</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-muted"><tr><th className="py-1 font-medium">Day</th><th className="font-medium">Claude</th><th className="font-medium">Vapi</th><th className="font-medium">Total</th></tr></thead>
          <tbody>
            {days.filter((d) => d.claude + d.vapi > 0).map((d) => (
              <tr key={d.day} className="border-t border-border"><td className="py-1">{label(d.day)}</td><td>{fmt(d.claude)}</td><td>{fmt(d.vapi)}</td><td>{fmt(d.claude + d.vapi)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
