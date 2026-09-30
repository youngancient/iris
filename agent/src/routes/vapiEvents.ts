import type { Request, Response } from "express";
import { endConversation, startConversation } from "../logging/conversations.js";

// Vapi server URL events: https://docs.vapi.ai/server-url/events
export async function vapiEvents(req: Request, res: Response) {
  const message = req.body?.message;
  const callId: string | undefined = message?.call?.id;

  if (callId) {
    if (message.type === "status-update" && message.status === "in-progress") {
      await startConversation(callId, message.call?.type === "webCall" ? "web" : "phone");
    }
    if (message.type === "end-of-call-report") {
      await endConversation(callId, message.analysis?.summary ?? message.summary ?? null);
    }
  }
  res.json({ ok: true });
}
