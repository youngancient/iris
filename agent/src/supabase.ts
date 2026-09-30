import { createClient } from "@supabase/supabase-js";
import { loadOrExit, loadSupabaseConfig } from "./config.js";

const { supabaseUrl, supabaseKey } = loadOrExit(loadSupabaseConfig);

export const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
