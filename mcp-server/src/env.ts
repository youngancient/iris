// Environment validation. Secrets and endpoints are required with no defaults:
// a missing or malformed value stops the process at startup, not on the first call.
// Only non-secret tunables have defaults, and those are range-checked.

export class EnvError extends Error {}

export function requireSecret(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value) throw new EnvError(`${name} must be set`);
  if (value.length < minLength) throw new EnvError(`${name} must be at least ${minLength} characters`);
  return value;
}

export function requireUrl(name: string): string {
  const value = requireSecret(name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvError(`${name} must be a valid URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new EnvError(`${name} must use https (http is only allowed for localhost)`);
  }
  return value.replace(/\/+$/, "");
}

export function optionalInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Print the problem (never a value) to stderr and exit. */
export function exitOnEnvError(err: unknown): never {
  console.error(err instanceof EnvError ? `Config error: ${err.message}` : err);
  process.exit(1);
}
