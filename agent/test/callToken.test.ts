import { describe, expect, it } from "vitest";
import { extractCallToken, signCallToken, verifyCallToken } from "../src/callToken.js";

const SECRET = "call-token-secret-at-least-32-characters";
const now = 1_800_000_000;

describe("call token", () => {
  it("round-trips", () => {
    const t = signCallToken(SECRET, { n: "x".repeat(22), e: now + 60 });
    expect(verifyCallToken(SECRET, t, now)).toEqual({ ok: true, nonce: "x".repeat(22), customerId: null });
  });
  it("carries the signed-in customer, and rejects a malformed customer ID", () => {
    const t = signCallToken(SECRET, { n: "x".repeat(22), e: now + 60, c: "CUS-1006" });
    expect(verifyCallToken(SECRET, t, now)).toMatchObject({ ok: true, customerId: "CUS-1006" });
    const bad = signCallToken(SECRET, { n: "x".repeat(22), e: now + 60, c: "anything'; drop table" });
    expect(verifyCallToken(SECRET, bad, now)).toMatchObject({ ok: false, reason: "malformed" });
  });
  it.each([
    [undefined, "missing"],
    ["", "missing"],
    ["no-dot", "malformed"],
    ["a.b.c", "malformed"],
  ])("%j → %s", (t, reason) => {
    expect(verifyCallToken(SECRET, t, now)).toMatchObject({ ok: false, reason });
  });
  it("rejects a tampered payload, a wrong secret and an expired token", () => {
    const t = signCallToken(SECRET, { n: "x".repeat(22), e: now + 60 });
    const [, sig] = t.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ n: "y".repeat(22), e: now + 60 })).toString("base64url")}.${sig}`;
    expect(verifyCallToken(SECRET, tampered, now)).toMatchObject({ reason: "bad_signature" });
    expect(verifyCallToken("another-secret-of-at-least-32-chars!!", t, now)).toMatchObject({ reason: "bad_signature" });
    expect(verifyCallToken(SECRET, t, now + 61)).toMatchObject({ reason: "expired" });
  });
  it("finds the token wherever Vapi forwards call metadata", () => {
    expect(extractCallToken({ metadata: { callToken: "a" } })).toBe("a");
    expect(extractCallToken({ call: { metadata: { callToken: "b" } } })).toBe("b");
    expect(extractCallToken({ call: { assistantOverrides: { metadata: { callToken: "c" } } } })).toBe("c");
    expect(extractCallToken({ call: {} })).toBeUndefined();
  });
});
