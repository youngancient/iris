import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrevoSender, createDiscordSender } from "../src/notify/senders.js";

afterEach(() => vi.unstubAllGlobals());

describe("Discord sender", () => {
  it("never lets posted text ping anyone, and trims to Discord's 2000-character limit", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    await createDiscordSender("bot-token-xxxxxxxxxxxxxxxx")("123", `@everyone ${"x".repeat(3000)}`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bot bot-token-xxxxxxxxxxxxxxxx");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });

  it("waits and retries once on a 429", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => (++n === 1 ? new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }) : new Response("{}", { status: 200 })));
    await createDiscordSender("bot-token-xxxxxxxxxxxxxxxx")("123", "hi");
    expect(n).toBe(2);
  });

  it("an error doesn't include the token", async () => {
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    await expect(createDiscordSender("secret-token-xxxxxxxxxxxx")("123", "hi")).rejects.toThrow(/Discord 401/);
    await expect(createDiscordSender("secret-token-xxxxxxxxxxxx")("123", "hi")).rejects.not.toThrow(/secret-token/);
  });
});

describe("Brevo sender", () => {
  it("sends the escalation ID as an idempotency key", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ messageId: "m" }), { status: 201 });
    });
    await createBrevoSender("brevo-key-xxx", "iris@relaypay.example")({ to: "t@x.example", subject: "s", text: "b", idempotencyKey: "escalation-ESC-1" });
    expect(headers["idempotency-key"]).toBe("escalation-ESC-1");
    expect(headers["api-key"]).toBe("brevo-key-xxx");
  });
});
