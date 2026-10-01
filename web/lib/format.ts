// Plain-language formatting for non-technical staff (design §15).

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function dateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function money(usd: number | null | undefined, digits = 2): string {
  if (usd == null || Number.isNaN(usd)) return "—";
  return `$${usd.toFixed(digits)}`;
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

export const STATUS_LABEL: Record<string, string> = { open: "Open", "in progress": "In progress", closed: "Closed" };
