"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/dal";
import { adminDb } from "@/lib/supabase";

const Input = z.object({ kind: z.string().max(64), conversationId: z.string().max(200), occurredAt: z.iso.datetime({ offset: true }) });

export async function acknowledge(form: FormData) {
  const admin = await requireAdmin();
  const parsed = Input.safeParse({ kind: form.get("kind"), conversationId: form.get("conversationId") ?? "", occurredAt: form.get("occurredAt") });
  if (!parsed.success) return;
  const { kind, conversationId, occurredAt } = parsed.data;
  const db = adminDb();
  await db.from("failure_acks").upsert(
    { kind, conversation_id: conversationId, occurred_at: occurredAt, acked_by: admin.email },
    { onConflict: "kind,occurred_at,conversation_id", ignoreDuplicates: true },
  );
  await db.from("admin_actions").insert({ admin_email: admin.email, action: "failure_acknowledged", record_id: conversationId || null, after_value: kind });
  revalidatePath("/admin/failures");
}
