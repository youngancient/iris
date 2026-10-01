import "server-only";

// Server-only configuration. Required values have no defaults: a missing one fails
// loudly with its name (never its value). Nothing here is NEXT_PUBLIC_, so none of it
// can reach the browser bundle.

function required(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Config error: ${name} must be set (web/.env.local)`);
  if (value.length < minLength) throw new Error(`Config error: ${name} must be at least ${minLength} characters`);
  return value;
}

function requiredUrl(name: string): string {
  const value = required(name);
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`Config error: ${name} must use https`);
  }
  return value.replace(/\/+$/, "");
}

/** Only what /api/call-token needs, so the public call page works without the dashboard's keys. */
export function callTokenEnv() {
  return {
    supabaseUrl: requiredUrl("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY", 20),
    callTokenSecret: required("CALL_TOKEN_SECRET", 32),
  };
}

/** Supabase access for customer sign-in and the session check (no staff allowlist needed). */
export function authEnv() {
  return {
    supabaseUrl: requiredUrl("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY", 20),
    supabaseAnonKey: required("SUPABASE_ANON_KEY", 20),
  };
}

