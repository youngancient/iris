import { afterEach, describe, expect, it } from "vitest";
import { EnvError, optionalInt, optionalNumber, optionalString, requireSecret, requireUrl } from "../src/env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("env validation", () => {
  it("required secrets have no default", () => {
    delete process.env.X_SECRET;
    expect(() => requireSecret("X_SECRET")).toThrow(EnvError);
    process.env.X_SECRET = "   ";
    expect(() => requireSecret("X_SECRET")).toThrow("X_SECRET must be set");
  });

  it("enforces a minimum length without echoing the value", () => {
    process.env.X_SECRET = "short-secret";
    expect(() => requireSecret("X_SECRET", 32)).toThrow("X_SECRET must be at least 32 characters");
    try {
      requireSecret("X_SECRET", 32);
    } catch (err) {
      expect(String(err)).not.toContain("short-secret");
    }
  });

  it("URLs must be https, except localhost", () => {
    process.env.X_URL = "http://example.com";
    expect(() => requireUrl("X_URL")).toThrow(/https/);
    process.env.X_URL = "not a url";
    expect(() => requireUrl("X_URL")).toThrow(/valid URL/);
    process.env.X_URL = "http://localhost:8788/mcp/";
    expect(requireUrl("X_URL")).toBe("http://localhost:8788/mcp");
  });

  it("tunables fall back when unset, but reject malformed values instead of becoming NaN", () => {
    delete process.env.X_NUM;
    expect(optionalNumber("X_NUM", 0.35, 0, 1)).toBe(0.35);
    process.env.X_NUM = "0,35";
    expect(() => optionalNumber("X_NUM", 0.35, 0, 1)).toThrow(EnvError);
    process.env.X_NUM = "2";
    expect(() => optionalNumber("X_NUM", 0.35, 0, 1)).toThrow(EnvError);
    process.env.X_INT = "1.5";
    expect(() => optionalInt("X_INT", 1000, 100, 10000)).toThrow(EnvError);
    process.env.X_STR = "gpt-4";
    expect(() => optionalString("X_STR", "claude-sonnet-5-5", /^claude-[a-z0-9-]+$/)).toThrow(EnvError);
  });
});
