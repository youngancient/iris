import { describe, expect, it } from "vitest";
import { createNotifier } from "../src/notify/notifier.js";
import type { Failure, KillSwitchChange, NotifyStore, PendingEscalation } from "../src/notify/store.js";

const cfg = { errorsChannelId: "ERR", escalationsChannelId: "ESC", supportEmail: "team@relaypay.example", dashboardUrl: "https://iris.example" };

function escalation(id: string, over: Partial<PendingEscalation> = {}): PendingEscalation {
  return {
    escalation_id: id, conversation_id: "call-1", ticket_id: "TKT-1", customer_id: null, user_name: "Efua Mensah",
    user_email: "efua@accrastack.example", category: "compliance", reason: "Account restricted @everyone", preferred_time: "tomorrow",
    created_at: new Date().toISOString(), notified_at: null, emailed_at: null, undelivered_alerted_at: null, ...over,
  };
}

function setup() {
  const escalations = new Map<string, PendingEscalation>();
  const cursor = { lastFailureAt: null as string | null, lastAdminActionAt: null as string | null };
  const failures: Failure[] = [];
  const changes: KillSwitchChange[] = [];
  const events: string[] = [];
  const store: NotifyStore = {
    pendingEscalations: async () => [...escalations.values()].filter((e) => !e.notified_at || !e.emailed_at),
    escalation: async (id) => escalations.get(id) ?? null,
    markNotified: async (id) => void (escalations.get(id)!.notified_at = new Date().toISOString()),
    markEmailed: async (id) => void (escalations.get(id)!.emailed_at = new Date().toISOString()),
    bumpAttempt: async () => {},
    markUndeliveredAlerted: async (id) => void (escalations.get(id)!.undelivered_alerted_at = new Date().toISOString()),
    cursor: async () => ({ ...cursor }),
    setCursor: async (f) => void Object.assign(cursor, f),
    failuresSince: async (iso) => failures.filter((f) => f.created_at > iso),
    killSwitchChangesSince: async (iso) => changes.filter((c) => c.created_at > iso),
    recordEvent: async (_c, type) => void events.push(type),
  };
  const posts: { channel: string; content: string }[] = [];
  const emails: { to: string; subject: string; text: string; idempotencyKey: string }[] = [];
  let discordDown = false;
  let emailDown = false;
  const notifier = createNotifier(
    store,
    async (channel, content) => {
      if (discordDown) throw new Error("discord down");
      posts.push({ channel, content });
    },
    async (msg) => {
      if (emailDown) throw new Error("brevo down");
      emails.push(msg);
    },
    cfg,
  );
  return {
    notifier, escalations, cursor, failures, changes, events, posts, emails,
    setDiscordDown: (v: boolean) => (discordDown = v), setEmailDown: (v: boolean) => (emailDown = v),
  };
}

describe("escalation delivery", () => {
  it("posts to #escalations with a masked email and no name, and emails the team the full details", async () => {
    const t = setup();
    t.escalations.set("ESC-1", escalation("ESC-1"));
    await t.notifier.escalationCreated("ESC-1");
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].channel).toBe("ESC");
    expect(t.posts[0].content).toContain("e***@accrastack.example");
    expect(t.posts[0].content).not.toContain("efua@");
    expect(t.posts[0].content).not.toContain("Efua Mensah");
    expect(t.emails[0]).toMatchObject({ to: "team@relaypay.example", idempotencyKey: "escalation-ESC-1" });
    expect(t.emails[0].text).toContain("Efua Mensah");
    expect(t.emails[0].text).toContain("efua@accrastack.example");
  });

  it("each channel is delivered at most once, even when the loop runs after the immediate delivery", async () => {
    const t = setup();
    t.escalations.set("ESC-1", escalation("ESC-1"));
    await Promise.all([t.notifier.escalationCreated("ESC-1"), t.notifier.tick()]);
    await t.notifier.tick();
    expect(t.posts.filter((p) => p.channel === "ESC")).toHaveLength(1);
    expect(t.emails).toHaveLength(1);
  });

  it("Discord down doesn't block the email, and the post is retried on the next pass", async () => {
    const t = setup();
    t.escalations.set("ESC-1", escalation("ESC-1"));
    t.setDiscordDown(true);
    await t.notifier.tick();
    expect(t.emails).toHaveLength(1);
    expect(t.escalations.get("ESC-1")!.notified_at).toBeNull();
    t.setDiscordDown(false);
    await t.notifier.tick();
    expect(t.posts.filter((p) => p.channel === "ESC")).toHaveLength(1);
    expect(t.emails).toHaveLength(1);
  });

  it("an escalation still undelivered after 15 minutes is flagged once", async () => {
    const t = setup();
    t.escalations.set("ESC-1", escalation("ESC-1", { created_at: new Date(Date.now() - 16 * 60_000).toISOString() }));
    t.setEmailDown(true);
    await t.notifier.tick();
    await t.notifier.tick();
    expect(t.events.filter((e) => e === "escalation_undelivered")).toHaveLength(1);
  });

  it("test (eval) escalations never notify", async () => {
    const t = setup();
    t.escalations.set("ESC-1", escalation("ESC-1", { conversation_id: "eval-run-S7-r1" }));
    await t.notifier.escalationCreated("ESC-1");
    await t.notifier.tick();
    expect(t.posts).toHaveLength(0);
    expect(t.emails).toHaveLength(0);
  });
});

describe("#errors", () => {
  it("the first pass starts from now instead of replaying old failures", async () => {
    const t = setup();
    t.failures.push({ created_at: new Date(Date.now() - 60_000).toISOString(), kind: "turn_failed", conversation_id: "c", source: "agent", detail: "x" });
    await t.notifier.tick();
    expect(t.posts.filter((p) => p.channel === "ERR")).toHaveLength(0);
    expect(t.cursor.lastFailureAt).not.toBeNull();
  });

  it("posts new failures once, batched, with emails masked", async () => {
    const t = setup();
    t.cursor.lastFailureAt = new Date(Date.now() - 120_000).toISOString();
    t.cursor.lastAdminActionAt = new Date().toISOString();
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    t.failures.push(
      { created_at: at(60), kind: "tool_error", conversation_id: "c1", source: "lookup_payout", detail: "timeout for amara@lagosledger.example" },
      { created_at: at(30), kind: "missed_followup", conversation_id: "c2", source: "event", detail: "no ticket" },
    );
    await t.notifier.tick();
    await t.notifier.tick();
    const errs = t.posts.filter((p) => p.channel === "ERR");
    expect(errs).toHaveLength(1);
    expect(errs[0].content).toContain("2 new failures");
    expect(errs[0].content).toContain("a***@lagosledger.example");
  });

  it("posts kill-switch changes with who and why", async () => {
    const t = setup();
    t.cursor.lastFailureAt = new Date().toISOString();
    t.cursor.lastAdminActionAt = new Date(Date.now() - 60_000).toISOString();
    t.changes.push({ created_at: new Date().toISOString(), admin_email: "jude@relaypay.example", action: "kill_switch_on", reason: "wrong payout dates" });
    await t.notifier.tick();
    await t.notifier.tick();
    const errs = t.posts.filter((p) => p.channel === "ERR");
    expect(errs).toHaveLength(1);
    expect(errs[0].content).toContain("Iris STOPPED");
    expect(errs[0].content).toContain("wrong payout dates");
  });
});
