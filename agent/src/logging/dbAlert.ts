import { log } from "../logger.js";

// When the agent can't write to the database, the failure can't reach #errors through
// the database either. It's reported to the MCP server instead, which posts it (the agent
// never holds the Discord token). Best effort: if the MCP server is down too, the log has it.

export type DbAlert = (what: string, err: unknown) => void;

export function createDbAlert(mcpUrl: string, mcpToken: string): DbAlert {
  const url = new URL("/internal/db-alert", mcpUrl).toString();
  return (what, err) => {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    void fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ what, error }),
      signal: AbortSignal.timeout(3000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`MCP server ${res.status}`);
      })
      .catch((alertErr) => log.error({ what, err: alertErr }, "database failure alert to the MCP server failed"));
  };
}

/**
 * Reports any failure of the named write methods, then rethrows it, so callers behave
 * exactly as before. Reads aren't wrapped: a failed read is handled where it happens.
 */
export function alertOnWriteFailure<T extends object>(store: T, writes: (keyof T & string)[], alert: DbAlert): T {
  const wrapped = { ...store };
  for (const name of writes) {
    const method = store[name];
    if (typeof method !== "function") continue;
    (wrapped as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => Promise<unknown>).apply(store, args);
      } catch (err) {
        alert(name, err);
        throw err;
      }
    };
  }
  return wrapped;
}
