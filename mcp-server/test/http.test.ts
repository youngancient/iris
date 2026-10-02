import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { seededDb } from "./helpers.js";

const TOKEN = "test-token-that-is-at-least-32-characters";
const db = seededDb();
const dbAlerts: string[] = [];
let base = "";
let close: () => void;

beforeAll(async () => {
  const server = createApp({ db, token: TOKEN, onRecordFailed: (where) => void dbAlerts.push(where) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const rpc = (headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

const callTool = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("HTTP transport", () => {
  it("rejects a missing token", async () => {
    expect((await rpc({}, callTool("lookup_transaction", { transaction_id: "TXN-9001" }))).status).toBe(401);
  });

  it("rejects a wrong token without echoing it", async () => {
    const res = await rpc({ authorization: "Bearer nope" }, callTool("lookup_transaction", { transaction_id: "TXN-9001" }));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("nope");
  });

  it("serves tool calls with a valid token, bound to the X-Conversation-Id header", async () => {
    const res = await rpc(
      { authorization: `Bearer ${TOKEN}`, "x-conversation-id": "call-123", "x-turn-index": "2" },
      callTool("lookup_transaction", { transaction_id: "TXN-9001" }),
    );
    expect(res.status).toBe(200);
    // That call isn't signed in, so the record isn't returned; the binding to the call is what's tested here.
    const body = (await res.json()) as { result: { structuredContent: { found: boolean } } };
    expect(body.result.structuredContent.found).toBe(false);
    expect(db.toolCalls.at(-1)).toMatchObject({ conversation_id: "call-123", turn_index: 2 });
  });

  it("health is open, MCP GET is not allowed", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });
});

describe("agent database alerts", () => {
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/internal/db-alert`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("needs the MCP token", async () => {
    expect((await post({}, { what: "completeTurn", error: "timeout" })).status).toBe(401);
    expect(dbAlerts).toEqual([]);
  });

  it("passes a valid report to the outage alert, labelled as the agent's", async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}` }, { what: "completeTurn", error: "connection refused" });
    expect(res.status).toBe(202);
    expect(dbAlerts).toEqual(["agent: completeTurn"]);
  });

  it("rejects a malformed report", async () => {
    expect((await post({ authorization: `Bearer ${TOKEN}` }, { what: "" })).status).toBe(400);
  });
});
