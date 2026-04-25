/**
 * /auth/callback — OAuth/magic-link redirect target.
 *
 * Exchanges the `code` query param for a session cookie, then hands the
 * user back to the dashboard. Errors fall back to /login with the
 * Supabase error surfaced.
 */

import { NextResponse, type NextRequest } from "next/server";
import { server } from "@/lib/supabase-server";

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/app";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing+code", url));
  }

  const supabase = await server();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const target = new URL("/login", url);
    target.searchParams.set("error", error.message);
    return NextResponse.redirect(target);
  }

  return NextResponse.redirect(new URL(next, url));
}
