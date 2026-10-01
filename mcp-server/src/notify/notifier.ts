import { maskEmails } from "../lib/mask.js";
import type { DiscordSender, EmailSender } from "./senders.js";
import type { Failure, KillSwitchChange, NoticeKind, NotifyStore, PendingEscalation, PendingTicket } from "./store.js";
import { log as logger } from "../logger.js";

// Delivers escalations to #escalations, tickets to #tickets, both to the support inbox, and failures and kill-switch
// changes to #errors (design §7.2). Delivery state is only advanced after the provider
// accepts the message, so a crash or outage means a retry, never a loss.

export type NotifierConfig = {
  errorsChannelId: string;
  escalationsChannelId: string;
  ticketsChannelId: string;
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

function ticketPost(cfg: NotifierConfig, t: PendingTicket): string {
  // Summaries can carry a caller's name or email: masked and shortened for a chat channel.
  return [
    `**New ticket ${t.ticket_id}** (${t.category}, ${t.priority} priority)`,
    `Summary: ${maskEmails(t.summary).slice(0, 300)}`,
    `${t.customer_id ? `Verified customer ${t.customer_id}` : "Caller not verified"}${t.transaction_id ? ` · Transaction ${t.transaction_id}` : ""}`,
    `Call: ${conversationLink(cfg, t.conversation_id)}`,
  ].join("\n");
}

function ticketEmail(cfg: NotifierConfig, t: PendingTicket) {
  return {
    to: cfg.supportEmail,
    idempotencyKey: `ticket-${t.ticket_id}`,
    subject: `[Iris] Ticket ${t.ticket_id}: ${t.category}, ${t.priority} priority`,
    text: [
      `Iris logged a support ticket for follow-up.`,
      ``,
      `Ticket: ${t.ticket_id}`,
      `Category: ${t.category}`,
      `Priority: ${t.priority}`,
      `Summary: ${t.summary}`,
      `Account: ${t.customer_id ? `${t.customer_id} (verified on the call)` : "not verified"}`,
      `Transaction: ${t.transaction_id ?? "none"}`,
      `Created: ${t.created_at}`,
      ``,
      `See the call: ${conversationLink(cfg, t.conversation_id)}`,
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

type Delivery = { id: string; conversation_id: string | null; created_at: string; notified_at: string | null; emailed_at: string | null; undelivered_alerted_at: string | null };

export function createNotifier(store: NotifyStore, discord: DiscordSender, email: EmailSender, cfg: NotifierConfig) {
  // The immediate delivery and the loop can reach the same record at once.
  const inFlight = new Set<string>();

  type Notice = { kind: "escalation"; record: PendingEscalation } | { kind: "ticket"; record: PendingTicket };

  const render = (n: Notice) =>
    n.kind === "escalation"
      ? { channelId: cfg.escalationsChannelId, post: escalationPost(cfg, n.record), mail: escalationEmail(cfg, n.record) }
      : { channelId: cfg.ticketsChannelId, post: ticketPost(cfg, n.record), mail: ticketEmail(cfg, n.record) };

  const delivery = (n: Notice): Delivery => ({ ...n.record, id: n.kind === "escalation" ? n.record.escalation_id : n.record.ticket_id });

  /** Posts and emails one record; each channel independently, each at most once. */
  async function deliver(n: Notice) {
    const { kind } = n;
    const d = delivery(n);
    const key = `${kind}:${d.id}`;
    if (d.conversation_id?.startsWith("eval-") || inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const c = render(n);
      if (!d.notified_at) {
        try {
          await discord(c.channelId, c.post);
          await store.markNotified(kind, d.id);
        } catch (err) {
          await store.bumpAttempt(kind, d.id, "discord").catch(() => {});
          log("warn", `${kind} Discord post failed, will retry`, { [`${kind}_id`]: d.id, err });
        }
      }
      if (!d.emailed_at) {
        try {
          await email(c.mail);
          await store.markEmailed(kind, d.id);
        } catch (err) {
          await store.bumpAttempt(kind, d.id, "email").catch(() => {});
          log("warn", `${kind} email failed, will retry`, { [`${kind}_id`]: d.id, err });
        }
      }
    } finally {
      inFlight.delete(key);
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

  async function flagUndelivered(kind: NoticeKind, pending: Delivery[], now: number) {
    const label = kind === "escalation" ? "Escalation" : "Ticket";
    for (const d of pending) {
      if (d.undelivered_alerted_at || now - Date.parse(d.created_at) < UNDELIVERED_AFTER_MS) continue;
      const missing = [!d.notified_at && "Discord", !d.emailed_at && "email"].filter(Boolean).join(" and ");
      await store.recordEvent(d.conversation_id, `${kind}_undelivered`, `${label} ${d.id} not delivered by ${missing} after 15 minutes.`, { [`${kind}_id`]: d.id });
      await store.markUndeliveredAlerted(kind, d.id);
    }
  }

  /** One pass: retry undelivered escalations and tickets, flag stuck ones, post failures and kill-switch changes. */
  async function tick(now = Date.now()) {
    const steps: [string, () => Promise<unknown>][] = [
      ["escalations", async () => {
        const pending = await store.pendingEscalations(BATCH);
        for (const record of pending) await deliver({ kind: "escalation", record });
        await flagUndelivered("escalation", pending.map((record) => delivery({ kind: "escalation", record })), now);
      }],
      ["tickets", async () => {
        const pending = await store.pendingTickets(BATCH);
        for (const record of pending) await deliver({ kind: "ticket", record });
        await flagUndelivered("ticket", pending.map((record) => delivery({ kind: "ticket", record })), now);
      }],
      ["failures", postFailures],
      ["kill switch", postKillSwitchChanges],
    ];
    // Each step on its own: Discord being down mustn't stop emails, and vice versa.
    for (const [name, step] of steps) {
      await step().catch((err) => log("error", `notifier ${name} step failed`, { err }));
    }
  }

  return {
    tick,
    /** Called right after an escalation is created, so the team hears about it in seconds, not at the next tick. */
    async escalationCreated(id: string) {
      const e = await store.escalation(id);
      if (e) await deliver({ kind: "escalation", record: e });
    },
    /** Same for tickets. Safe to call for an existing ticket: delivered channels are skipped. */
    async ticketCreated(id: string) {
      const t = await store.ticket(id);
      if (t) await deliver({ kind: "ticket", record: t });
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
