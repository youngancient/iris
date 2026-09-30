import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Db } from "./db/types.js";
import { buildServer } from "./server.js";

type Options = { db: Db; token: string; readinessCheck?: () => Promise<void> };

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ db, token, readinessCheck }: Options) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", async (_req, res) => {
    try {
      await readinessCheck?.();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Bearer token on every MCP request. The token itself is never logged or echoed.
  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!given || !tokensMatch(given, token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.post("/mcp", requireToken, async (req, res) => {
    const turnHeader = req.get("x-turn-index");
    const turnIndex = turnHeader !== undefined && /^\d+$/.test(turnHeader) ? Number(turnHeader) : null;
    const server = buildServer({ db, conversationId: req.get("x-conversation-id")?.trim() || null, turnIndex });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "mcp request failed", err: String(err) }));
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  // Stateless mode: no sessions to resume or delete.
  app.all("/mcp", requireToken, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "method not allowed" });
  });

  return app;
}
