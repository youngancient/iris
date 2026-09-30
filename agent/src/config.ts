import { EnvError, exitOnEnvError, optionalInt, optionalNumber, optionalString, requireSecret, requireUrl } from "./env.js";

// Each entry point loads only what it needs, so `npm run ingest-kb` doesn't demand
// the Vapi secret. Every loader fails fast with the variable's name, never its value.

export function loadSupabaseConfig() {
  return {
    supabaseUrl: requireUrl("SUPABASE_URL"),
    supabaseKey: requireSecret("SUPABASE_SERVICE_ROLE_KEY", 20),
  };
}

export function loadRetrievalConfig() {
  return {
    voyageKey: requireSecret("VOYAGE_API_KEY", 10),
    // Must match what the knowledge base was ingested with, and support 512 dimensions.
    voyageModel: optionalString("VOYAGE_MODEL", "voyage-4-lite", /^voyage-[a-z0-9.-]+$/),
    // Normal query embedding is ~100–300ms; past this, full-text search is faster (design §7.1).
    embedTimeoutMs: optionalInt("EMBED_TIMEOUT_MS", 1000, 100, 10_000),
    // Calibrated on voyage-4-lite (2026-09-30): on-topic 0.40–0.59, off-topic 0.13–0.24.
    similarityThreshold: optionalNumber("RETRIEVAL_THRESHOLD", 0.35, 0, 1),
  };
}

export function loadServerConfig() {
  return {
    ...loadSupabaseConfig(),
    ...loadRetrievalConfig(),
    anthropicKey: requireSecret("ANTHROPIC_API_KEY", 20),
    vapiSecret: requireSecret("VAPI_SECRET", 32),
    mcpUrl: requireUrl("MCP_URL"),
    mcpToken: requireSecret("MCP_TOKEN", 32),
    agentModel: optionalString("AGENT_MODEL", "claude-sonnet-5-5", /^claude-[a-z0-9-]+$/),
    port: optionalInt("PORT", 8787, 1, 65535),
  };
}

/** Load a config at startup, exiting with a clear message if anything is missing or malformed. */
export function loadOrExit<T>(loader: () => T): T {
  try {
    return loader();
  } catch (err) {
    if (err instanceof EnvError) exitOnEnvError(err);
    throw err;
  }
}
