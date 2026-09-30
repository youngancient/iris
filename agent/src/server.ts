import { createClient } from "@supabase/supabase-js";
import { createAgentSdkRunner } from "./agent/modelRunner.js";
import { createRetriever, supabaseSearch } from "./agent/retrieval.js";
import { createApp } from "./app.js";
import { loadOrExit, loadServerConfig } from "./config.js";
import { createVoyageEmbedder } from "./kb/voyage.js";
import { createSupabaseCallStore } from "./logging/callStore.js";
import { createSupabaseTurnStore } from "./logging/turnStore.js";

// Fail at startup, not on the first call, if anything required is missing.
const config = loadOrExit(loadServerConfig);

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(4000) }) },
});

const retrieve = createRetriever({
  embed: createVoyageEmbedder(config.voyageKey, config.voyageModel),
  ...supabaseSearch(supabase),
  similarityThreshold: config.similarityThreshold,
  embedTimeoutMs: config.embedTimeoutMs,
});

const app = createApp({
  vapiSecret: config.vapiSecret,
  turn: {
    store: createSupabaseTurnStore(supabase),
    runModel: createAgentSdkRunner({ model: config.agentModel, mcpUrl: config.mcpUrl, mcpToken: config.mcpToken }),
    retrieve,
    model: config.agentModel,
  },
  calls: createSupabaseCallStore(supabase),
});

// Warm the Supabase and Voyage connections so the first caller doesn't pay for cold TLS setup.
async function warmUp() {
  const started = Date.now();
  const results = await Promise.allSettled([
    supabase.from("kb_chunks").select("id").limit(1),
    createVoyageEmbedder(config.voyageKey, config.voyageModel)(["warm up"], "query", 5000),
  ]);
  const failed = results.filter((r) => r.status === "rejected").length;
  console.error(JSON.stringify({ level: failed ? "warn" : "info", msg: "warm-up done", ms: Date.now() - started, failed }));
}

app.listen(config.port, () => {
  console.error(`agent listening on :${config.port}`);
  void warmUp();
});
