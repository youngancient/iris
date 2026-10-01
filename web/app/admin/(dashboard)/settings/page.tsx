import { verifyAdmin } from "@/lib/dal";
import { dateTime } from "@/lib/format";
import { getMaintenance } from "@/lib/settings";
import { adminDb } from "@/lib/supabase";
import { KillSwitch } from "./kill-switch";

export default async function SettingsPage() {
  await verifyAdmin();
  const [state, history] = await Promise.all([
    getMaintenance().catch(() => null),
    adminDb().from("admin_actions").select("admin_email, action, reason, created_at").in("action", ["kill_switch_on", "kill_switch_off"]).order("created_at", { ascending: false }).limit(10),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-[15px] font-semibold">Emergency stop</h2>
        <p className="mt-1 text-[14px] leading-6 text-muted">
          Stops Iris answering calls, without anyone needing to redeploy. Use it if Iris starts saying something wrong, or costs spike.
          Callers hear a short unavailable message instead. Every change is recorded with who made it and why.
        </p>
        {state ? (
          <p className="mt-4 text-[14px]">
            Iris is <span className={`font-semibold ${state.on ? "text-danger" : "text-accent"}`}>{state.on ? "stopped" : "on"}</span>
            {state.updatedBy && <span className="text-muted">, last changed by {state.updatedBy} on {dateTime(state.updatedAt)}</span>}.
          </p>
        ) : (
          <p role="alert" className="mt-4 text-[14px] text-danger">The current state couldn&apos;t be loaded. Refresh to try again.</p>
        )}
        {state && <div className="mt-4"><KillSwitch on={state.on} /></div>}
      </section>

      <section className="mt-6">
        <h2 className="text-[14px] font-medium">Recent changes</h2>
        <ul className="mt-2 space-y-1 text-[14px] text-muted">
          {(history.data ?? []).map((h, i) => (
            <li key={i}>{dateTime(h.created_at)}: {h.admin_email} {h.action === "kill_switch_on" ? "stopped Iris" : "turned Iris back on"}{h.reason ? `: “${h.reason}”` : ""}</li>
          ))}
          {(history.data ?? []).length === 0 && <li>No changes yet.</li>}
        </ul>
      </section>
    </div>
  );
}
