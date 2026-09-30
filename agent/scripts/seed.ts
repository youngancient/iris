// Loads artifact/assets/seed-data/*.csv into Supabase. Safe to re-run (upserts).
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { supabase } from "../src/supabase.js";

const dir = new URL("../../artifact/assets/seed-data/", import.meta.url);

// Order matters: foreign keys.
const tables = [
  { table: "customers", key: "customer_id" },
  { table: "transactions", key: "transaction_id" },
  { table: "payouts", key: "payout_id" },
];

for (const { table, key } of tables) {
  const rows: Record<string, string | null>[] = parse(readFileSync(new URL(`${table}.csv`, dir)), {
    columns: true,
    skip_empty_lines: true,
    cast: (value) => (value === "" ? null : value),
  });
  const { error } = await supabase.from(table).upsert(rows, { onConflict: key });
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`${table}: ${rows.length} rows`);
}
