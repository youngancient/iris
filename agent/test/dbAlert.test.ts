import { afterEach, describe, expect, it, vi } from "vitest";
import { alertOnWriteFailure, createDbAlert } from "../src/logging/dbAlert.js";

describe("agent database write alerts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a failed write and rethrows it unchanged", async () => {
    const alerts: string[] = [];
    const store = alertOnWriteFailure(
      { completeTurn: async () => Promise.reject(new Error("connection refused")), priorActions: async () => "ok" },
      ["completeTurn"],
      (what) => void alerts.push(what),
    );
    await expect(store.completeTurn()).rejects.toThrow("connection refused");
    expect(alerts).toEqual(["completeTurn"]);
  });

  it("leaves successful writes and unwrapped reads alone", async () => {
    const alerts: string[] = [];
    const store = alertOnWriteFailure(
      { completeTurn: async () => true, priorActions: async () => Promise.reject(new Error("read failed")) },
      ["completeTurn"],
      (what) => void alerts.push(what),
    );
    expect(await store.completeTurn()).toBe(true);
    await expect(store.priorActions()).rejects.toThrow("read failed");
    expect(alerts).toEqual([]);
  });

  it("posts to the MCP server's internal endpoint with the MCP token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    });
    createDbAlert("http://localhost:8788/mcp", "t".repeat(32))("completeTurn", new Error("timeout"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://localhost:8788/internal/db-alert");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(32)}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ what: "completeTurn", error: "timeout" });
  });

  it("never throws when the MCP server is unreachable", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("ECONNREFUSED")));
    expect(() => createDbAlert("http://localhost:8788/mcp", "t".repeat(32))("event", new Error("x"))).not.toThrow();
  });
});
