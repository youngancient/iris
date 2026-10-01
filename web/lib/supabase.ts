import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { authEnv } from "./env";

/**
 * Service-role client for dashboard data. Bypasses RLS, so it is only ever called
 * after verifyAdmin() (lib/dal.ts). Every query has a hard timeout.
 */
export function adminDb() {
  const env = authEnv();
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
}

/** Supabase Auth client bound to the request's cookies (sign-in, sign-out, session). */
export async function authClient() {
  // Cookies first: it marks the request as dynamic before any config is read, so admin
  // pages are rendered per request and never at build time.
  const store = await cookies();
  const env = authEnv();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, { ...options, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
        } catch {
          // Called from a Server Component, where cookies are read-only; the proxy refreshes them.
        }
      },
    },
  });
}

/** A throwaway auth client that never touches cookies: used to re-check a password. */
export function passwordChecker() {
  const env = authEnv();
  return createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
