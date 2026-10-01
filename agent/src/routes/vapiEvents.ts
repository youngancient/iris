import type { Request, Response } from "express";
import { finalStatus, type CallStore } from "../logging/callStore.js";
import { log } from "../logger.js";

// Vapi server-URL events. Only the end-of-call report matters here; everything
// else is acknowledged and ignored. Redeliveries are safe (endCall and the
// reconciliation check are idempotent).
/** A valid timestamp from Vapi's report, or null (never trust an unparseable value into the database). */
const isoOrNull = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

export function vapiEvents(store: CallStore) {
  return async (req: Request, res: Response) => {
    const message = req.body?.message;
    const callId: unknown = message?.call?.id;
    if (message?.type !== "end-of-call-report" || typeof callId !== "string" || !callId) {
      res.json({ ok: true });
      return;
    }

    // Why Vapi ended the call: the only trace when it fails before reaching the agent.
    const endedReason = typeof message.endedReason === "string" ? message.endedReason : null;
    const normalEnd = endedReason && /^(customer-ended-call|assistant-ended-call|assistant-said-end-call-phrase|exceeded-max-duration)$/.test(endedReason);
    const hasSummary = Boolean(message.analysis?.summary ?? message.summary);
    log[normalEnd ? "info" : "warn"]({ conversation_id: callId, ended_reason: endedReason, duration_s: message.durationSeconds ?? null, has_summary: hasSummary }, "call ended");

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
        startedAt: isoOrNull(message.startedAt ?? message.call?.startedAt),
        endedAt: isoOrNull(message.endedAt ?? message.call?.endedAt),
      });

      // A record needing follow-up was seen, but no ticket was created (design §4.4).
      if (summary.followUpSeen && summary.tickets === 0 && !(await store.hasEvent(callId, "missed_followup"))) {
        await store.event(callId, "missed_followup", "A lookup needed specialist follow-up, but no ticket was created in this call.");
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ conversation_id: callId, err }, "end-of-call handling failed");
      // 500 so Vapi retries the delivery.
      res.status(500).json({ ok: false });
    }
  };
}
