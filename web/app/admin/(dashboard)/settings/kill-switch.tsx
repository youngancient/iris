"use client";

import { useActionState, useEffect, useRef } from "react";
import { setKillSwitch, type KillSwitchResult } from "./actions";

export function KillSwitch({ on }: { on: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [result, action, pending] = useActionState<KillSwitchResult | null, FormData>(setKillSwitch, null);

  useEffect(() => {
    if (result?.ok) {
      dialog.current?.close();
      form.current?.reset();
    }
  }, [result]);

  const turnOn = !on;
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className={`h-10 rounded-md px-5 text-[14px] font-medium text-white ${turnOn ? "bg-danger" : "bg-primary hover:bg-primary-hover"}`}
      >
        {turnOn ? "Stop Iris" : "Turn Iris back on"}
      </button>
      {result?.ok && <p role="status" className="mt-3 text-[14px] text-accent">{result.message}</p>}

      <dialog ref={dialog} className="m-auto w-[min(92vw,28rem)] rounded-lg border border-border bg-surface p-0 backdrop:bg-black/30">
        <form ref={form} action={action} className="p-5">
          <h2 className="text-[16px] font-semibold">{turnOn ? "Stop Iris?" : "Turn Iris back on?"}</h2>
          <p className="mt-2 text-[14px] leading-6 text-muted">
            {turnOn
              ? "Iris will stop answering on all calls, including calls in progress, within about 10 seconds. Callers will hear: “Support is temporarily unavailable. Please use your RelayPay dashboard.”"
              : "Iris will start answering calls again within about 10 seconds. Only do this once whatever made you stop her has been fixed."}
          </p>
          <input type="hidden" name="turnOn" value={String(turnOn)} />
          <label className="mt-4 block">
            <span className="text-[14px] font-medium">Reason</span>
            <input name="reason" required minLength={5} maxLength={500} placeholder={turnOn ? "For example: Iris is giving wrong payout dates" : "For example: the prompt fix is deployed"} className="mt-1 h-10 w-full rounded-md border border-border px-3 text-[14px]" />
          </label>
          <label className="mt-3 block">
            <span className="text-[14px] font-medium">Your password</span>
            <input name="password" type="password" required autoComplete="current-password" className="mt-1 h-10 w-full rounded-md border border-border px-3 text-[14px]" />
          </label>
          {result && !result.ok && <p role="alert" className="mt-3 text-[14px] text-danger">{result.message}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className="h-10 rounded-md border border-border px-4 text-[14px]">Cancel</button>
            <button type="submit" disabled={pending} className={`h-10 rounded-md px-4 text-[14px] font-medium text-white disabled:opacity-60 ${turnOn ? "bg-danger" : "bg-primary"}`}>
              {pending ? "Checking…" : turnOn ? "Stop Iris" : "Turn back on"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
