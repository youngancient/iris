import { maskEmails } from "../lib/mask.js";
import { log } from "../logger.js";
import type { DiscordSender } from "./senders.js";

// #errors is fed from the database, so it can't report the database failing. When a
// tool can't write its own record, or the agent can't write a turn record (it reports
// through /internal/db-alert), this posts to #errors directly instead.
// Best effort: nothing is stored, so if Discord is down too, only the server log has it.
// At most one post per window: during an outage the rest are counted into the next one.

const WINDOW_MS = 60_000;

export function createOutageAlerter(discord: DiscordSender, channelId: string, windowMs = WINDOW_MS, now = () => Date.now()) {
  let lastSentAt = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  let pending = { count: 0, tools: new Set<string>(), latest: "" };

  async function flush() {
    timer = null;
    if (pending.count === 0) return;
    const { count, tools, latest } = pending;
    pending = { count: 0, tools: new Set(), latest: "" };
    lastSentAt = now();
    const content = [
      `**Iris: database writes failing** (${count} ${count === 1 ? "write" : "writes"} couldn't be recorded)`,
      `Where: ${[...tools].join(", ")}`,
      `Latest error: ${maskEmails(latest).slice(0, 200)}`,
      `These records are missing from the dashboard and from failure alerts. Check Supabase.`,
    ].join("\n");
    await discord(channelId, content).catch((err) => log.error({ err }, "outage alert to Discord failed"));
  }

  return {
    /** A write couldn't be recorded (a tool record, or an agent write). Never throws, never blocks the caller. */
    report(tool: string, err: unknown) {
      pending.count++;
      pending.tools.add(tool);
      pending.latest = err instanceof Error ? err.message : String(err);
      if (timer) return;
      const wait = Math.max(0, lastSentAt + windowMs - now());
      timer = setTimeout(() => void flush(), wait);
      timer.unref();
    },
  };
}

export type OutageAlerter = ReturnType<typeof createOutageAlerter>;
