import type { Request, Response } from "express";
import { finalStatus, type CallStore } from "../logging/callStore.js";

// Vapi server-URL events. Only the end-of-call report matters here; everything
// else is acknowledged and ignored. Redeliveries are safe (endCall and the
// reconciliation check are idempotent).
export function vapiEvents(store: CallStore) {
  return async (req: Request, res: Response) => {
    const message = req.body?.message;
    const callId: unknown = message?.call?.id;
    if (message?.type !== "end-of-call-report" || typeof callId !== "string" || !callId) {
      res.json({ ok: true });
      return;
    }

    try {
      const summary = await store.summarize(callId);
      await store.endCall(callId, {
        summary: message.analysis?.summary ?? message.summary ?? null,
        finalStatus: finalStatus(summary),
        // Web calls have no phone number: the identified customer, else the call ID (design §2 step 7).
        callerId: summary.identifiedCustomer ?? callId,
        // Field names checked against a real report in step 6; anything non-numeric is left empty.
        costUsd: typeof message.cost === "number" ? message.cost : null,
        durationS: typeof message.durationSeconds === "number" ? message.durationSeconds : null,
      });

      // A record needing follow-up was seen, but no ticket was created (design §4.4).
      if (summary.followUpSeen && summary.tickets === 0 && !(await store.hasEvent(callId, "missed_followup"))) {
        await store.event(callId, "missed_followup", "A lookup needed specialist follow-up, but no ticket was created in this call.");
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "end-of-call handling failed", conversation_id: callId, err: String(err) }));
      // 500 so Vapi retries the delivery.
      res.status(500).json({ ok: false });
    }
  };
}
