// Writes the PRD testing evidence table for the latest eval run to docs/testing-evidence.md.
// Read-only against Supabase.
import { writeFileSync } from "node:fs";
import { supabase } from "../src/supabase.js";

const { data, error } = await supabase
  .from("v_testing_evidence")
  .select("test_scenario, expected_behavior, actual_behavior, result, notes, run_id");
if (error) throw new Error(`v_testing_evidence: ${error.message}`);
if (!data || data.length === 0) throw new Error("no evaluations yet: run npm run evals first");

const cell = (s: string | null) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const rows = data.map((r) => `| ${cell(r.test_scenario)} | ${cell(r.expected_behavior)} | ${cell(r.actual_behavior)} | ${cell(r.result)} | ${cell(r.notes)} |`);

const md = `# Testing evidence

Latest eval run: \`${data[0].run_id}\`. Each row is one scripted conversation run through the real agent
(Claude Agent SDK, MCP server, Supabase, knowledge-base retrieval), graded by deterministic checks plus an LLM judge.

| Test scenario | Expected behavior | Actual behavior | Pass/fail | Notes |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
| S9: Voice flow | Vapi captures speech, the agent responds, Vapi speaks the reply, Supabase logs the conversation and tool calls. | Checked by hand with a real web call (see the voice smoke test). | manual | Evals call the agent directly, without Vapi. |
`;
writeFileSync(new URL("../../docs/testing-evidence.md", import.meta.url), md);
console.log(`wrote docs/testing-evidence.md (${data.length} rows from run ${data[0].run_id})`);
