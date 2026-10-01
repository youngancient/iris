// Request-time clock for server components (they render per request, so this is safe).
export function nowMs(): number {
  return Date.now();
}
