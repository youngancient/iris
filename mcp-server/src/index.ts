#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseDb } from "./db/supabaseDb.js";
import { exitOnEnvError, optionalInt, requireBoolean, requireEmail, requireSecret, requireUrl } from "./env.js";
import { createApp } from "./http.js";
import { createNotifier, type Notifier } from "./notify/notifier.js";
import { createBrevoSender, createDiscordSender } from "./notify/senders.js";
import { createSupabaseNotifyStore } from "./notify/store.js";
import { buildServer } from "./server.js";

// stdout is the MCP channel in stdio mode, so everything human-readable goes to stderr.
const stdio = process.argv.includes("--stdio");
const NOTIFY_INTERVAL_MS = 60_000;

let config;
try {
  const notify = stdio ? false : requireBoolean("NOTIFY");
  config = {
    supabaseUrl: requireUrl("SUPABASE_URL"),
    supabaseKey: requireSecret("SUPABASE_SERVICE_ROLE_KEY", 20),
    // HTTP mode only: stdio is a local pipe with no network exposure.
    mcpToken: stdio ? null : requireSecret("MCP_TOKEN", 32),
    port: optionalInt("MCP_PORT", optionalInt("PORT", 8788, 1, 65535), 1, 65535),
    // With NOTIFY=true every notification setting is required; with false, none are read.
    notify: notify
      ? {
          discordToken: requireSecret("DISCORD_BOT_TOKEN", 20),
          errorsChannelId: requireSecret("DISCORD_ERRORS_CHANNEL_ID", 5),
          escalationsChannelId: requireSecret("DISCORD_ESCALATIONS_CHANNEL_ID", 5),
          brevoKey: requireSecret("BREVO_API_KEY", 10),
          senderEmail: requireEmail("BREVO_SENDER_EMAIL"),
          supportEmail: requireEmail("SUPPORT_TEAM_EMAIL"),
          dashboardUrl: requireUrl("DASHBOARD_URL"),
        }
      : null,
  };
} catch (err) {
  exitOnEnvError(err);
}

const db = createSupabaseDb(config.supabaseUrl, config.supabaseKey);

if (stdio) {
  // Local dev only: one conversation for the life of the process.
  const server = buildServer({ db, conversationId: process.env.MCP_CONVERSATION_ID?.trim() || null, turnIndex: null });
  await server.connect(new StdioServerTransport());
  console.error("relaypay-support MCP server running on stdio");
} else {
  let notifier: Notifier | null = null;
  if (config.notify) {
    const n = config.notify;
    const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) },
    });
    notifier = createNotifier(createSupabaseNotifyStore(supabase), createDiscordSender(n.discordToken), createBrevoSender(n.brevoKey, n.senderEmail), {
      errorsChannelId: n.errorsChannelId,
      escalationsChannelId: n.escalationsChannelId,
      supportEmail: n.supportEmail,
      dashboardUrl: n.dashboardUrl,
    });
    // One pass at a time: a slow pass is never overlapped by the next.
    let running = false;
    const pass = async () => {
      if (running) return;
      running = true;
      await notifier!.tick().finally(() => (running = false));
    };
    setInterval(() => void pass(), NOTIFY_INTERVAL_MS).unref();
    setTimeout(() => void pass(), 5000).unref();
  } else {
    console.error("Notifications are off (NOTIFY=false): no Discord posts or escalation emails.");
  }

  const app = createApp({
    db,
    token: config.mcpToken!,
    readinessCheck: async () => void (await db.customerById("CUS-0000")),
    onEscalationCreated: notifier ? (id) => void notifier!.escalationCreated(id).catch(() => {}) : undefined,
  });
  app.listen(config.port, () => console.error(`relaypay-support MCP server listening on :${config.port}/mcp`));
}
