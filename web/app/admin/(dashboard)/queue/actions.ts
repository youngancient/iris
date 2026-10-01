"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/dal";
import { adminDb } from "@/lib/supabase";

const Input = z.object({
  kind: z.enum(["ticket", "escalation"]),
  id: z.string().regex(/^(TKT|ESC)-[A-Z0-9]{4,16}$/),
  expected: z.enum(["open", "in progress", "closed"]),
  status: z.enum(["open", "in progress", "closed"]),
  note: z.string().max(1000).optional(),
});

export type UpdateResult = { ok: boolean; message: string };

export async function updateStatus(_prev: UpdateResult | null, form: FormData): Promise<UpdateResult> {
  const admin = await requireAdmin();
  const parsed = Input.safeParse({
    kind: form.get("kind"), id: form.get("id"), expected: form.get("expected"),
    status: form.get("status"), note: (form.get("note") as string | null)?.trim() || undefined,
  });
  if (!parsed.success) return { ok: false, message: "That change couldn't be saved. Refresh the page and try again." };
  const { kind, id, expected, status, note } = parsed.data;
  if (status === expected && !note) return { ok: true, message: "Nothing to save." };

  const db = adminDb();
  const table = kind === "ticket" ? "support_tickets" : "escalations";
  const key = kind === "ticket" ? "ticket_id" : "escalation_id";
  // Conditional on the status the staff member saw, so two people can't silently overwrite each other.
  const { data, error } = await db
    .from(table)
    .update({ status, status_updated_at: new Date().toISOString(), ...(note ? { staff_note: note } : {}) })
    .eq(key, id)
    .eq("status", expected)
    .select(key);
  if (error) return { ok: false, message: "That change couldn't be saved right now. Try again in a moment." };
  if (!data || data.length === 0) return { ok: false, message: "Someone else changed this while you were looking. Refresh to see the latest." };

  await db.from("admin_actions").insert({
    admin_email: admin.email, action: `${kind}_status`, record_id: id, before_value: expected, after_value: status, reason: note ?? null,
  });
  revalidatePath("/admin/queue");
  return { ok: true, message: status === expected ? "Note saved." : `Marked as ${status}.` };
}
