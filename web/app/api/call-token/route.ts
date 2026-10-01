import { createClient } from "@supabase/supabase-js";
import { hashIp, issueCallToken } from "@/lib/callToken";
import { getSignedInCustomer } from "@/lib/customer";
import { callTokenEnv } from "@/lib/env";

// Issues a short-lived token the call page passes to Vapi; the agent refuses web calls
// without one (design §8). Rate-limited per visitor so the page can't be used to start
// calls in bulk.
const LIMIT_PER_HOUR = 5;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(request: Request) {
  // Only our own page should ask for tokens.
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json(403, { error: "forbidden" });

  let env;
  try {
    env = callTokenEnv();
  } catch (err) {
    console.error(String(err));
    return json(503, { error: "Calling isn't available right now." });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const ipHash = hashIp(env.callTokenSecret, ip);
  const db = createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  });

  const { count, error } = await db
    .from("call_token_issues")
    .select("*", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  if (error) return json(503, { error: "Calling isn't available right now." });
  if ((count ?? 0) >= LIMIT_PER_HOUR) {
    return json(429, { error: "You've started several calls recently. Please wait a while before calling again." });
  }

  const { error: insertError } = await db.from("call_token_issues").insert({ ip_hash: ipHash });
  if (insertError) return json(503, { error: "Calling isn't available right now." });

  // Checked here on the server from the session: the browser can't choose who it's signed in as.
  const customer = await getSignedInCustomer().catch(() => null);
  return json(200, { token: issueCallToken(env.callTokenSecret, customer?.customerId ?? null) });
}
