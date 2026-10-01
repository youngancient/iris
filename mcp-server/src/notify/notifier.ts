import { maskEmails } from "../lib/mask.js";
import type { DiscordSender, EmailSender } from "./senders.js";
import type { Failure, KillSwitchChange, NotifyStore, PendingEscalation } from "./store.js";
import { log as logger } from "../logger.js";

// Delivers escalations to #escalations and the support inbox, and failures and kill-switch
// changes to #errors (design §7.2). Delivery state is only advanced after the provider
// accepts the message, so a crash or outage means a retry, never a loss.

export type NotifierConfig = {
  errorsChannelId: string;
  escalationsChannelId: string;
  supportEmail: string;
  dashboardUrl: string;
};

const UNDELIVERED_AFTER_MS = 15 * 60 * 1000;
const BATCH = 20;

const conversationLink = (cfg: NotifierConfig, id: string | null) =>
  id ? `${cfg.dashboardUrl}/admin/conversations/${encodeURIComponent(id)}` : `${cfg.dashboardUrl}/admin/failures`;

function escalationPost(cfg: NotifierConfig, e: PendingEscalation): string {
  // No caller name, and a masked email: Discord is a chat channel, not the place for contact details.
  return [
    `**New escalation ${e.escalation_id}** (${e.category})`,
    `Reason: ${e.reason}`,
    `Callback: ${e.preferred_time || "no time given"} · Email: ${e.user_email ? maskEmails(e.user_email) : "none"}`,
    `${e.customer_id ? `Verified customer ${e.customer_id}` : "Caller not verified"}${e.ticket_id ? ` · Ticket ${e.ticket_id}` : ""}`,
    `Open: ${cfg.dashboardUrl}/admin/queue · Call: ${conversationLink(cfg, e.conversation_id)}`,
  ].join("\n");
}

function escalationEmail(cfg: NotifierConfig, e: PendingEscalation) {
  return {
    to: cfg.supportEmail,
    idempotencyKey: `escalation-${e.escalation_id}`,
    subject: `[Iris] Escalation ${e.escalation_id}: ${e.category}${e.preferred_time ? `, callback ${e.preferred_time}` : ""}`,
    text: [
      `A caller asked for a specialist.`,
      ``,
      `Escalation: ${e.escalation_id}`,
      `Category: ${e.category}`,
      `Reason: ${e.reason}`,
      `Name: ${e.user_name ?? "not given"}`,
      `Email: ${e.user_email ?? "not given"}`,
      `Preferred callback: ${e.preferred_time || "no time given"}`,
      `Account: ${e.customer_id ? `${e.customer_id} (verified on the call)` : "not verified"}`,
      `Ticket: ${e.ticket_id ?? "none"}`,
      `Created: ${e.created_at}`,
      ``,
      `See the call: ${conversationLink(cfg, e.conversation_id)}`,
      `Work the queue: ${cfg.dashboardUrl}/admin/queue`,
    ].join("\n"),
  };
}

const failureLine = (cfg: NotifierConfig, f: Failure) =>
  `• ${f.kind.replace(/_/g, " ")}${f.source && f.source !== "event" ? ` (${f.source})` : ""}: ${maskEmails(f.detail ?? "").slice(0, 160)} · ${conversationLink(cfg, f.conversation_id)}`;

const killSwitchLine = (k: KillSwitchChange) =>
  k.action === "kill_switch_on"
    ? `**Iris STOPPED** by ${k.admin_email}${k.reason ? `. Reason: ${k.reason}` : ""}`
    : `**Iris turned back on** by ${k.admin_email}${k.reason ? `. Reason: ${k.reason}` : ""}`;

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  logger[level](extra, msg);

export function createNotifier(store: NotifyStore, discord: DiscordSender, email: EmailSender, cfg: NotifierConfig) {
  // The immediate delivery and the loop can reach the same escalation at once.
  const inFlight = new Set<string>();

  /** Posts and emails one escalation; each channel independently, each at most once. */
  async function deliverEscalation(e: PendingEscalation) {
    if (e.conversation_id?.startsWith("eval-") || inFlight.has(e.escalation_id)) return;
    inFlight.add(e.escalation_id);
    try {
      await deliverChannels(e);
    } finally {
      inFlight.delete(e.escalation_id);
    }
  }

  async function deliverChannels(e: PendingEscalation) {
    if (!e.notified_at) {
      try {
        await discord(cfg.escalationsChannelId, escalationPost(cfg, e));
        await store.markNotified(e.escalation_id);
      } catch (err) {
        await store.bumpAttempt(e.escalation_id, "discord").catch(() => {});
        log("warn", "escalation Discord post failed, will retry", { escalation_id: e.escalation_id, err });
      }
    }
    if (!e.emailed_at) {
      try {
        await email(escalationEmail(cfg, e));
        await store.markEmailed(e.escalation_id);
      } catch (err) {
        await store.bumpAttempt(e.escalation_id, "email").catch(() => {});
        log("warn", "escalation email failed, will retry", { escalation_id: e.escalation_id, err });
      }
    }
  }

  async function postFailures() {
    const { lastFailureAt } = await store.cursor();
    // First run: start from now rather than replaying the last 24 hours.
    if (!lastFailureAt) return store.setCursor({ lastFailureAt: new Date().toISOString() });
    const failures = await store.failuresSince(lastFailureAt, BATCH);
    if (failures.length === 0) return;
    const header = failures.length === 1 ? "**Iris: 1 new failure**" : `**Iris: ${failures.length} new failures**`;
    await discord(cfg.errorsChannelId, [header, ...failures.map((f) => failureLine(cfg, f))].join("\n"));
    await store.setCursor({ lastFailureAt: failures.at(-1)!.created_at });
  }

  async function postKillSwitchChanges() {
    const { lastAdminActionAt } = await store.cursor();
    if (!lastAdminActionAt) return store.setCursor({ lastAdminActionAt: new Date().toISOString() });
    const changes = await store.killSwitchChangesSince(lastAdminActionAt, BATCH);
    for (const change of changes) {
      await discord(cfg.errorsChannelId, killSwitchLine(change));
      await store.setCursor({ lastAdminActionAt: change.created_at });
    }
  }

  async function flagUndelivered(pending: PendingEscalation[], now: number) {
    for (const e of pending) {
      if (e.undelivered_alerted_at || now - Date.parse(e.created_at) < UNDELIVERED_AFTER_MS) continue;
      const missing = [!e.notified_at && "Discord", !e.emailed_at && "email"].filter(Boolean).join(" and ");
      await store.recordEvent(e.conversation_id, "escalation_undelivered", `Escalation ${e.escalation_id} not delivered by ${missing} after 15 minutes.`, { escalation_id: e.escalation_id });
      await store.markUndeliveredAlerted(e.escalation_id);
    }
  }

  /** One pass: retry undelivered escalations, flag stuck ones, post failures and kill-switch changes. */
  async function tick(now = Date.now()) {
    const steps: [string, () => Promise<unknown>][] = [
      ["escalations", async () => {
        const pending = await store.pendingEscalations(BATCH);
        for (const e of pending) await deliverEscalation(e);
        await flagUndelivered(pending, now);
      }],
      ["failures", postFailures],
      ["kill switch", postKillSwitchChanges],
    ];
    // Each step on its own: Discord being down mustn't stop escalation emails, and vice versa.
    for (const [name, step] of steps) {
      await step().catch((err) => log("error", `notifier ${name} step failed`, { err }));
    }
  }

  return {
    tick,
    /** Called right after an escalation is created, so the team hears about it in seconds, not at the next tick. */
    async escalationCreated(id: string) {
      const e = await store.escalation(id);
      if (e) await deliverEscalation(e);
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
