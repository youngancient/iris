import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { TurnDeps } from "./agent/runTurn.js";
import type { CallStore } from "./logging/callStore.js";
import { chatCompletions } from "./routes/chatCompletions.js";
import { vapiEvents } from "./routes/vapiEvents.js";

type AppDeps = { vapiSecret: string; turn: TurnDeps; calls: CallStore };

export function createApp({ vapiSecret, turn, calls }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const matches = (given: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(vapiSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // Vapi sends the custom-LLM credential as "Authorization: Bearer …". Server-URL
  // events can carry it the same way or as X-Vapi-Secret. The secret is never logged.
  const requireVapi = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : (req.get("x-vapi-secret") ?? "");
    if (!given || !matches(given)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/chat/completions", requireVapi, chatCompletions(turn));
  app.post("/vapi/events", requireVapi, vapiEvents(calls));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(JSON.stringify({ level: "error", msg: "unhandled", err: String(err) }));
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
