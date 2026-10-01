// Discord and Brevo over plain fetch. Nothing here logs a token or key.

export type DiscordSender = (channelId: string, content: string) => Promise<void>;
export type EmailSender = (msg: { to: string; subject: string; text: string; idempotencyKey: string }) => Promise<void>;

const DISCORD_MAX = 2000;

export function createDiscordSender(botToken: string): DiscordSender {
  return async (channelId, content) => {
    const body = JSON.stringify({
      content: content.length > DISCORD_MAX ? `${content.slice(0, DISCORD_MAX - 1)}…` : content,
      // Caller-provided text is posted here: never let it ping anyone (@everyone, roles, users).
      allowed_mentions: { parse: [] },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return;
      if (res.status === 429 && attempt === 0) {
        const { retry_after } = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((r) => setTimeout(r, Math.min(10, Math.max(0.5, retry_after ?? 1)) * 1000));
        continue;
      }
      throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  };
}

export function createBrevoSender(apiKey: string, senderEmail: string): EmailSender {
  return async ({ to, subject, text, idempotencyKey }) => {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        sender: { name: "Iris (RelayPay support)", email: senderEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        tags: ["iris-escalation"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
