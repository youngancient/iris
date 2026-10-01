import "server-only";
import { adminDb } from "./supabase";

export async function getMaintenance(): Promise<{ on: boolean; updatedBy: string | null; updatedAt: string | null }> {
  const { data, error } = await adminDb().from("app_settings").select("maintenance, updated_by, updated_at").eq("id", true).maybeSingle();
  if (error) throw new Error(`app_settings: ${error.message}`);
  return { on: Boolean(data?.maintenance), updatedBy: data?.updated_by ?? null, updatedAt: data?.updated_at ?? null };
}
