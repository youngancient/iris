import express from "express";
import { chatCompletions } from "./routes/chatCompletions.js";
import { vapiEvents } from "./routes/vapiEvents.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Vapi sends this header (configured as a credential on the assistant).
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!process.env.VAPI_SECRET || req.get("x-vapi-secret") !== process.env.VAPI_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/chat/completions", chatCompletions);
app.post("/vapi/events", vapiEvents);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`agent listening on :${port}`));
