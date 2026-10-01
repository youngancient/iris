import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: no Supabase auth cookie on an admin page → go to sign-in.
// The real check is verifyAdmin() in lib/dal.ts, on every page and action.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin/login") return NextResponse.next();
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
  if (!hasSession) return NextResponse.redirect(new URL("/admin/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*"] };
