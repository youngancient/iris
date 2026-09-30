import type { Request, Response } from "express";
import { z } from "zod";
import { runAgent } from "../agent/runAgent.js";

// Vapi Custom LLM sends an OpenAI-style chat completion request.
const body = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional() })),
  call: z.object({ id: z.string() }).passthrough().optional(),
  stream: z.boolean().optional(),
});

export async function chatCompletions(req: Request, res: Response) {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const { messages, call } = parsed.data;
  const conversationId = call?.id ?? `local-${Date.now()}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (content: string, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: conversationId,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
      })}\n\n`,
    );

  try {
    for await (const text of runAgent({ conversationId, messages })) send(text);
  } catch (err) {
    console.error(err);
    send("Sorry, I'm having trouble right now. Please try again in a moment.");
  }
  send("", "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}
