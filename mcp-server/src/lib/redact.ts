/**
 * Customer-safe field allowlists. Anything not listed here never leaves the
 * MCP server, so it can't be spoken aloud regardless of what the prompt says.
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(row: T, keys: K[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? ""])) as Pick<T, K>;
}
