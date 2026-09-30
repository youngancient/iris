import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { FAILURE_REPLY, runTurn, type TurnDeps } from "../agent/runTurn.js";

// Vapi's custom LLM calls an OpenAI-compatible /chat/completions with stream: true
// and expects chat.completion.chunk SSE events ending with [DONE].
const body = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
  call: z.object({ id: z.string().min(1) }).passthrough(),
  stream: z.boolean().optional(),
});

export function chatCompletions(deps: TurnDeps) {
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
