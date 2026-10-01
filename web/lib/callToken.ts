import "server-only";
import { createHmac, randomBytes } from "node:crypto";

// Same format the agent verifies (agent/src/callToken.ts): base64url(payload).base64url(HMAC-SHA256).
const TOKEN_TTL_SECONDS = 120;

/** customerId is set only from a server-checked session, never from the request. */
export function issueCallToken(secret: string, customerId: string | null): string {
  const payload = {
    n: randomBytes(16).toString("base64url"),
    e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    ...(customerId ? { c: customerId } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** A keyed hash of the visitor's IP: enough to rate-limit, without storing the IP. */
export function hashIp(secret: string, ip: string): string {
  return createHmac("sha256", `${secret}:ip`).update(ip).digest("hex").slice(0, 32);
}
