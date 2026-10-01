import { createClient } from "@supabase/supabase-js";
import { createAgentSdkRunner } from "./agent/modelRunner.js";
import { createRetriever, supabaseSearch } from "./agent/retrieval.js";
import { createApp } from "./app.js";
import { loadOrExit, loadServerConfig } from "./config.js";
import { createVoyageEmbedder } from "./kb/voyage.js";
import { createSupabaseCallGateStore } from "./logging/callGateStore.js";
import { createSupabaseCallStore } from "./logging/callStore.js";
import { createSupabaseTurnStore } from "./logging/turnStore.js";
import { alertOnWriteFailure, createDbAlert } from "./logging/dbAlert.js";
import { log } from "./logger.js";

// Fail at startup, not on the first call, if anything required is missing.
const config = loadOrExit(loadServerConfig);

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(6000) }) },
});

// Failed database writes are reported to the MCP server, which posts them to #errors.
const dbAlert = createDbAlert(config.mcpUrl, config.mcpToken);

const retrieve = createRetriever({
  embed: createVoyageEmbedder(config.voyageKey, config.voyageModel),
  ...alertOnWriteFailure(supabaseSearch(supabase), ["log"], dbAlert),
  similarityThreshold: config.similarityThreshold,
  embedTimeoutMs: config.embedTimeoutMs,
});

// Kill switch, read at most every 10s (design §15). If the read fails, the last known
// value stands: a database blip shouldn't flip Iris on or off.
let maintenance = { on: false, readAt: 0 };
async function isMaintenance(): Promise<boolean> {
  if (Date.now() - maintenance.readAt < 10_000) return maintenance.on;
  const { data, error } = await supabase.from("app_settings").select("maintenance").eq("id", true).maybeSingle();
  if (error) {
    log.warn({ on: maintenance.on }, "kill switch read failed, keeping last value");
    maintenance = { ...maintenance, readAt: Date.now() };
    return maintenance.on;
  }
  maintenance = { on: Boolean(data?.maintenance), readAt: Date.now() };
  return maintenance.on;
}

const callGate = alertOnWriteFailure(createSupabaseCallGateStore(supabase), ["claimNonce", "event"], dbAlert);

const app = createApp({
  vapiSecret: config.vapiSecret,
  turn: {
    store: alertOnWriteFailure(createSupabaseTurnStore(supabase), ["claimTurn", "completeTurn", "failTurn", "event", "toolCallRejected"], dbAlert),
    runModel: createAgentSdkRunner({ model: config.agentModel, mcpUrl: config.mcpUrl, mcpToken: config.mcpToken }),
    retrieve,
    model: config.agentModel,
    maintenance: isMaintenance,
    spend: { soFar: (id) => callGate.spentSoFar(id), capUsd: config.callSpendCapUsd },
  },
  calls: alertOnWriteFailure(createSupabaseCallStore(supabase), ["endCall", "event"], dbAlert),
  gate: { store: callGate, tokenSecret: config.callTokenSecret },
});

// Warm the Supabase and Voyage connections so the first caller doesn't pay for cold TLS setup.
async function warmUp() {
  const started = Date.now();
  const results = await Promise.allSettled([
    supabase.from("kb_chunks").select("id").limit(1),
    createVoyageEmbedder(config.voyageKey, config.voyageModel)(["warm up"], "query", 5000),
  ]);
  const failed = results.filter((r) => r.status === "rejected").length;
  log[failed ? "warn" : "info"]({ ms: Date.now() - started, failed }, "warm-up done");
}

app.listen(config.port, () => {
  log.info(`agent listening on :${config.port}`);
  void warmUp();
});
