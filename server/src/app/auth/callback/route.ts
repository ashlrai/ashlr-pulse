/**
 * /auth/callback — OAuth/magic-link redirect target.
 *
 * Exchanges the `code` query param for a session cookie, then hands the
 * user back to the dashboard. Errors fall back to /login with the
 * Supabase error surfaced.
 */

import { NextResponse, type NextRequest } from "next/server";
import { server } from "@/lib/supabase-server";

/**
 * Only accept same-origin relative paths. Rejects:
 *   - protocol-relative URLs ("//evil.com")
 *   - absolute URLs ("https://evil.com", "javascript:...")
 *   - anything not starting with a single "/"
 *   - any value containing "\" — WHATWG URL parsing normalizes
 *     backslash to forward slash, so "/\evil.com" resolves to
 *     "https://evil.com" when handed to `new URL(next, base)`.
 *   - any value containing CR/LF — bypassed Set-Cookie / response-split
 *     attempts.
 */
function safeNext(raw: string | null): string {
  const v = raw ?? "/app";
  if (!v.startsWith("/")) return "/app";
  if (v.startsWith("//")) return "/app";
  if (v.includes("\\")) return "/app";
  if (/[\r\n]/.test(v)) return "/app";
  return v;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

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
