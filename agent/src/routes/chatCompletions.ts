import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { END_CALL_PHRASE, FAILURE_REPLY, runTurn, type TurnDeps } from "../agent/runTurn.js";
import { extractCallToken, verifyCallToken } from "../callToken.js";
import type { CallGateStore } from "../logging/callGateStore.js";

export const CALL_REJECTED_REPLY = `Sorry, this call couldn't be started. Please refresh the page and try again. ${END_CALL_PHRASE}`;

export type CallGate = { store: CallGateStore; tokenSecret: string };

/**
 * Web calls must have been started with a token from our page (design §8). Checked once per
 * call: the first verified turn records it, later turns read the flag. The model is never
 * called for a call that fails this.
 */
async function callAllowed(gate: CallGate, callId: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const call = (body.call ?? {}) as { type?: string };
  if (call.type === "inboundPhoneCall" || call.type === "outboundPhoneCall") return { ok: true }; // no browser to issue a token
  if (await gate.store.isVerified(callId)) return { ok: true };
  const check = verifyCallToken(gate.tokenSecret, extractCallToken(body));
  if (!check.ok) return check;
  if (!(await gate.store.claimNonce(callId, check.nonce, check.customerId))) return { ok: false, reason: "reused" };
  return { ok: true };
}

// Vapi's custom LLM calls an OpenAI-compatible /chat/completions with stream: true
// and expects chat.completion.chunk SSE events ending with [DONE].
const body = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
  call: z.object({ id: z.string().min(1) }).passthrough(),
  stream: z.boolean().optional(),
});

export function chatCompletions(deps: TurnDeps, gate: CallGate | null) {
  return async (req: Request, res: Response) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      console.error(JSON.stringify({ level: "warn", msg: "bad chat/completions body", issues: parsed.error.issues.map((i) => i.path.join(".")) }));
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const { messages, call } = parsed.data;
    const id = `chatcmpl-${randomUUID()}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (content: string | null, finish: "stop" | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "iris",
          choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
        })}\n\n`,
      );

    let spokeAnything = false;
    try {
      if (gate) {
        const allowed = await callAllowed(gate, call.id, req.body);
        if (!allowed.ok) {
          // The reason only, never the token itself.
          await gate.store.event(call.id, "call_token_invalid", `Call refused: ${allowed.reason} start token.`, { reason: allowed.reason }).catch(() => {});
          send(CALL_REJECTED_REPLY);
          send(null, "stop");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
      }
      for await (const sentence of runTurn(deps, { conversationId: call.id, channel: "web", messages })) {
        send(`${sentence} `);
        spokeAnything = true;
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "turn failed", conversation_id: call.id, err: String(err) }));
      if (!spokeAnything) send(FAILURE_REPLY);
    }
    send(null, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  };
}
