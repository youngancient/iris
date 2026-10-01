// Creates or updates the Vapi assistant from vapi/assistant.json, so its configuration is
// versioned in the repo rather than living only in the Vapi dashboard (design §12).
//
//   npm run vapi:sync
//
// Needs VAPI_PRIVATE_KEY, VAPI_SECRET and AGENT_URL (the deployed agent's public https URL).
// With VAPI_ASSISTANT_ID set it updates that assistant; without it, it creates one and prints the ID.
import { readFileSync } from "node:fs";
import { loadOrExit } from "../src/config.js";
import { requireSecret, requireUrl } from "../src/env.js";

const config = loadOrExit(() => ({
  privateKey: requireSecret("VAPI_PRIVATE_KEY", 10),
  vapiSecret: requireSecret("VAPI_SECRET", 32),
  agentUrl: requireUrl("AGENT_URL"),
  assistantId: process.env.VAPI_ASSISTANT_ID?.trim() || null,
}));

const template = readFileSync(new URL("../../vapi/assistant.json", import.meta.url), "utf8");
const assistant = JSON.parse(template.replaceAll("${AGENT_URL}", config.agentUrl));

// The shared secret goes in headers, never in the committed JSON. The agent checks it on
// every request: Bearer on /chat/completions, X-Vapi-Secret on /vapi/events.
assistant.model.headers = { authorization: `Bearer ${config.vapiSecret}` };
assistant.server.headers = { "x-vapi-secret": config.vapiSecret };

const res = await fetch(`https://api.vapi.ai/assistant${config.assistantId ? `/${config.assistantId}` : ""}`, {
  method: config.assistantId ? "PATCH" : "POST",
  headers: { authorization: `Bearer ${config.privateKey}`, "content-type": "application/json" },
  body: JSON.stringify(assistant),
});
const body = (await res.json().catch(() => ({}))) as { id?: string; message?: unknown };
if (!res.ok) {
  // Vapi's error body describes the invalid field; it doesn't echo our keys.
  console.error(`Vapi returned ${res.status}:`, JSON.stringify(body.message ?? body).slice(0, 500));
  process.exit(1);
}
console.log(`${config.assistantId ? "Updated" : "Created"} assistant ${body.id}`);
if (!config.assistantId) {
  console.log("Add to .env:  VAPI_ASSISTANT_ID=" + body.id);
  console.log("Add to web/.env.local:  NEXT_PUBLIC_VAPI_ASSISTANT_ID=" + body.id);
}
