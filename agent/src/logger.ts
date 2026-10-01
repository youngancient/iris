import pino from "pino";

// Structured logs on stderr (stdout is the MCP channel in stdio mode).
// Readable output in a local terminal; JSON lines everywhere else.
const pretty = process.stderr.isTTY && process.env.NODE_ENV !== "production";

export const log = pino(
  {
    level: process.env.LOG_LEVEL?.trim() || "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Locally just the message keeps the terminal readable; deployed logs keep the full stack.
    serializers: { err: pretty ? (err: unknown) => (err instanceof Error ? err.message : String(err)) : pino.stdSerializers.err },
    redact: { paths: ["row.input_summary", "row.result_summary"], censor: "[redacted]" },
  },
  pretty
    ? pino.transport({ target: "pino-pretty", options: { destination: 2, colorize: true } })
    : pino.destination(2),
);
