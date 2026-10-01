"use client";

import { useActionState } from "react";
import { updateStatus, type UpdateResult } from "./actions";

export function StatusForm({ kind, id, status, note }: { kind: "ticket" | "escalation"; id: string; status: string; note: string | null }) {
  const [result, action, pending] = useActionState<UpdateResult | null, FormData>(updateStatus, null);
  return (
    <form action={action} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="expected" value={status} />
      <label className="sr-only" htmlFor={`status-${id}`}>Status</label>
      <select id={`status-${id}`} name="status" defaultValue={status} className="h-9 rounded-md border border-border bg-surface px-2 text-[14px]">
        <option value="open">Open</option>
        <option value="in progress">In progress</option>
        <option value="closed">Closed</option>
      </select>
      <label className="sr-only" htmlFor={`note-${id}`}>Staff note</label>
      <input id={`note-${id}`} name="note" defaultValue={note ?? ""} placeholder="Add a note for the team (optional)" maxLength={1000} className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[14px]" />
      <button type="submit" disabled={pending} className="h-9 rounded-md bg-primary px-4 text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>
      {result && <p role="status" className={`self-center text-[13px] ${result.ok ? "text-accent" : "text-danger"}`}>{result.message}</p>}
    </form>
  );
}
