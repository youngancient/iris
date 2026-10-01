import { createHmac, timingSafeEqual } from "node:crypto";

// Call-start token (design §8): base64url(payload) "." base64url(HMAC-SHA256). Issued by the
// web app's /api/call-token, checked here on the first turn. web/lib/callToken.ts makes the same format.

// nonce, expiry (unix seconds), and the signed-in customer (set by the web app after checking the session).
export type TokenPayload = { n: string; e: number; c?: string };

const b64url = (buf: Buffer) => buf.toString("base64url");

export function signCallToken(secret: string, payload: TokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}

export type TokenCheck = { ok: true; nonce: string; customerId: string | null } | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" };

export function verifyCallToken(secret: string, token: unknown, nowSeconds = Math.floor(Date.now() / 1000)): TokenCheck {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || token.length > 512) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.n !== "string" || payload.n.length < 16 || typeof payload.e !== "number") return { ok: false, reason: "malformed" };
  if (payload.e < nowSeconds) return { ok: false, reason: "expired" };
  if (payload.c !== undefined && (typeof payload.c !== "string" || !/^CUS-\d+$/.test(payload.c))) return { ok: false, reason: "malformed" };
  return { ok: true, nonce: payload.n, customerId: payload.c ?? null };
}

/**
 * Where the token can be in Vapi's custom-LLM request. The web page sends it as call
 * metadata; which field Vapi forwards it in is confirmed on the first real call (design §8).
 */
export function extractCallToken(body: Record<string, unknown>): unknown {
  const call = (body.call ?? {}) as Record<string, any>;
  return (
    (body.metadata as Record<string, unknown> | undefined)?.callToken ??
    call.metadata?.callToken ??
    call.assistantOverrides?.metadata?.callToken ??
    call.assistantOverrides?.variableValues?.callToken
  );
}
