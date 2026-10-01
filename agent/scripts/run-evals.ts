// Runs the eval scenarios through the real agent (Claude, MCP, Supabase, Voyage)
// and writes one evaluations row per scenario run (design §11).
//
//   npm run evals -- [--model claude-sonnet-5-5] [--runs 1] [--only S1,S4] [--judge claude-haiku-4-5] [--max-usd 1] [--dry-run]
//
// Spending is capped: the run stops before a scenario that could take it past --max-usd,
// and aborts if the first 3 scenarios all error (a wiring problem, not a model problem).
//
// Needs the MCP server running at MCP_URL. Eval traffic uses channel "eval" and
// conversation IDs "eval-<run_id>-…", so it never mixes with real calls.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createAgentSdkRunner } from "../src/agent/modelRunner.js";
import { createRetriever, supabaseSearch } from "../src/agent/retrieval.js";
import { runTurn } from "../src/agent/runTurn.js";
import { loadOrExit, loadRetrievalConfig, loadSupabaseConfig } from "../src/config.js";
import { requireSecret, requireUrl } from "../src/env.js";
import { createVoyageEmbedder } from "../src/kb/voyage.js";
import { createSupabaseTurnStore } from "../src/logging/turnStore.js";
import { collectArtifacts } from "../evals/artifacts.js";
import { createJudge } from "../evals/judge.js";
import { claimsMatchRecords, SCENARIOS } from "../evals/scenarios.js";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-5-5" },
    runs: { type: "string", default: "1" },
    "max-usd": { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
    // A stronger judge than the model under test: a weak judge misreads the rules (design §11).
    judge: { type: "string", default: "claude-sonnet-5-5" },
  },
});

const config = loadOrExit(() => ({
  ...loadSupabaseConfig(),
  ...loadRetrievalConfig(),
  anthropicKey: requireSecret("ANTHROPIC_API_KEY", 20),
  mcpUrl: requireUrl("MCP_URL"),
  mcpToken: requireSecret("MCP_TOKEN", 32),
}));
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be 1–10");
if (!/^claude-[a-z0-9-]+$/.test(args.model!) || !/^claude-[a-z0-9-]+$/.test(args.judge!)) throw new Error("invalid model name");

const maxUsd = Number(args["max-usd"]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 20) throw new Error("--max-usd must be between 0 and 20");
// Worst case one scenario can spend: the per-turn SDK ceiling is $0.25, but a normal turn is ~$0.01.
// Reserve a realistic margin per upcoming scenario rather than the theoretical maximum.
const RESERVE_PER_TURN_USD = 0.03;
const JUDGE_RESERVE_USD = 0.005;

const selected = args.only ? SCENARIOS.filter((s) => args.only!.split(",").includes(s.id)) : SCENARIOS;
if (selected.length === 0) throw new Error(`no scenarios match --only ${args.only}`);

const totalTurns = selected.reduce((n, s) => n + s.turns.length, 0) * runs;
console.log(`plan: ${selected.length} scenarios (${selected.map((s) => s.id).join(", ")}) × ${runs} run(s) = ${totalTurns} agent turns`);
console.log(`estimated cost ~$${(totalTurns * 0.01 + selected.length * runs * 0.002).toFixed(2)}, hard cap $${maxUsd.toFixed(2)}`);
if (args["dry-run"]) process.exit(0);

// Fail early if the MCP server isn't up, instead of recording every scenario as failed.
const health = await fetch(new URL("/health", config.mcpUrl)).catch(() => null);
if (!health?.ok) throw new Error(`MCP server not reachable at ${config.mcpUrl} (start it with: cd mcp-server && npm run dev)`);

const supabase = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
const retrieve = createRetriever({
  embed: createVoyageEmbedder(config.voyageKey, config.voyageModel),
  ...supabaseSearch(supabase),
  similarityThreshold: config.similarityThreshold,
  embedTimeoutMs: config.embedTimeoutMs,
});
const store = createSupabaseTurnStore(supabase);
const judge = createJudge(args.judge!);
const runner = (mcpUrl: string) => createAgentSdkRunner({ model: args.model!, mcpUrl, mcpToken: config.mcpToken });

// Warm the Supabase and Voyage connections first (as the server does at startup), so
// cold-connection delays don't show up as failures in the first scenario.
await Promise.allSettled([
  supabase.from("kb_chunks").select("id").limit(1),
  createVoyageEmbedder(config.voyageKey, config.voyageModel)(["warm up"], "query", 10_000),
]);

const runId = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${args.model!.replace(/^claude-/, "")}-${randomBytes(2).toString("hex")}`;
console.log(`run ${runId}: ${selected.length} scenarios × ${runs} runs, model ${args.model}, judge ${args.judge}\n`);

type Outcome = { id: string; rep: number; passed: boolean; errored: boolean; firstSpokenMs: number[]; costUsd: number };
const outcomes: Outcome[] = [];
let spentUsd = 0;
let stopReason: string | null = null;

run: for (let rep = 1; rep <= runs; rep++) {
  for (const scenario of selected) {
    const reserve = scenario.turns.length * RESERVE_PER_TURN_USD + JUDGE_RESERVE_USD;
    if (spentUsd + reserve > maxUsd) {
      stopReason = `spending cap: $${spentUsd.toFixed(3)} spent, next scenario could exceed $${maxUsd.toFixed(2)}`;
      break run;
    }
    if (outcomes.length === 3 && outcomes.every((o) => o.errored)) {
      stopReason = "the first 3 scenarios all errored: check the MCP server, keys and migrations before spending more";
      break run;
    }
    const conversationId = `eval-${runId}-${scenario.id}-r${rep}`;
    const deps = {
      store,
      retrieve,
      model: args.model!,
      // A closed port: every MCP connection fails, as if the server were down.
      runModel: runner(scenario.mcpDown ? "http://127.0.0.1:9/mcp" : config.mcpUrl),
    };

    if (scenario.signedInAs) {
      // As the call-start token would for a signed-in customer.
      const { error } = await supabase
        .from("conversations")
        .upsert({ conversation_id: conversationId, channel: "eval", identified_customer_id: scenario.signedInAs }, { onConflict: "conversation_id" });
      if (error) throw new Error(`signing in ${scenario.id}: ${error.message}`);
    }

    const messages: { role: string; content: string }[] = [];
    const spoken: string[] = [];
    let error: string | null = null;
    try {
      for (const line of scenario.turns) {
        messages.push({ role: "user", content: line });
        const sentences: string[] = [];
        for await (const s of runTurn(deps, { conversationId, channel: "eval", messages })) sentences.push(s);
        const reply = sentences.join(" ");
        spoken.push(reply);
        messages.push({ role: "assistant", content: reply });
      }
    } catch (err) {
      error = String(err);
    }

    const artifacts = await collectArtifacts(supabase, conversationId, spoken, scenario.turns);
    const checks = { ...scenario.checks(artifacts), claims_match_records: claimsMatchRecords(artifacts) };
    const errored = Boolean(error) || (artifacts.turns.length > 0 && artifacts.turns.every((t) => t.status === "failed") && !scenario.mcpDown);
    const verdict = error
      ? { pass: false, reason: `conversation errored: ${error}` }
      : await judge(scenario.expected, scenario.judgeNotes, artifacts.transcript).catch((err) => ({ pass: false, reason: `judge failed: ${err}` }));

    const failedChecks = Object.entries(checks).filter(([, c]) => !c.pass);
    const passed = !error && failedChecks.length === 0 && verdict.pass;
    const firstSpokenMs = artifacts.turns.map((t) => t.timings?.first_spoken).filter((v): v is number => typeof v === "number");
    const costUsd = artifacts.turns.reduce((sum, t) => sum + Number(t.cost_usd ?? 0), 0);
    spentUsd += costUsd + JUDGE_RESERVE_USD;
    outcomes.push({ id: scenario.id, rep, passed, errored, firstSpokenMs, costUsd });

    const notes = [
      failedChecks.length ? `Failed checks: ${failedChecks.map(([k, c]) => `${k} (${c.detail})`).join("; ")}.` : "All deterministic checks passed.",
      `Judge: ${verdict.reason}`,
      `Model ${args.model}; first words ${firstSpokenMs.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(", ") || "n/a"}; cost $${costUsd.toFixed(4)}.`,
    ].join(" ");

    const { error: insertError } = await supabase.from("evaluations").insert({
      run_id: runId,
      scenario_id: scenario.id,
      scenario: `${scenario.id}: ${scenario.name}`,
      conversation_id: conversationId,
      expected_behavior: scenario.expected,
      actual_behavior: artifacts.transcript,
      passed,
      checks: { ...checks, judge: verdict },
      judge_model: args.judge,
      notes,
    });
    if (insertError) console.error(`  could not save evaluation: ${insertError.message}`);

    console.log(`${passed ? "PASS" : "FAIL"}  ${scenario.id} r${rep}  ${scenario.name}`);
    if (!passed) console.log(`      ${notes}`);
  }
}

// Summary: pass counts per scenario, and time-to-first-words across every turn.
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const allFirst = outcomes.flatMap((o) => o.firstSpokenMs);
console.log(`\nSummary for ${runId}`);
for (const s of selected) {
  const mine = outcomes.filter((o) => o.id === s.id);
  console.log(`  ${s.id.padEnd(3)} ${mine.filter((o) => o.passed).length}/${mine.length}  ${s.name}`);
}
console.log(
  `  first words: p50 ${(pct(allFirst, 50) / 1000).toFixed(1)}s, p95 ${(pct(allFirst, 95) / 1000).toFixed(1)}s over ${allFirst.length} turns; ` +
    `total cost $${outcomes.reduce((s, o) => s + o.costUsd, 0).toFixed(3)}`,
);
console.log(`  passed ${outcomes.filter((o) => o.passed).length}/${outcomes.length}`);
if (stopReason) {
  console.log(`  STOPPED EARLY: ${stopReason}`);
  process.exitCode = 1;
}
