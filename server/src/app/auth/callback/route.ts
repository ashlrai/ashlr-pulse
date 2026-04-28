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
 *   - any ASCII control character (0x00–0x1f) — the WHATWG URL parser
 *     SILENTLY STRIPS tab (0x09), LF (0x0a), and CR (0x0d) before state
 *     processing, so "/\tevil.com" becomes "//evil.com" → external host.
 *     Rejecting the whole 0x00–0x1f range is broader-but-safer than
 *     listing the three.
 */
function safeNext(raw: string | null): string {
  const v = raw ?? "/app";
  if (!v.startsWith("/")) return "/app";
  if (v.startsWith("//")) return "/app";
  if (v.includes("\\")) return "/app";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(v)) return "/app";
  return v;
}

export async function GET(req: NextRequest): Promise<Response> {
  const reqUrl = new URL(req.url);
  const code = reqUrl.searchParams.get("code");
  const next = safeNext(reqUrl.searchParams.get("next"));

  // Same bug pattern as /api/agent-onboard/start: req.url on Railway
  // reflects the bind address (0.0.0.0:3000) not the public host. Use
  // NEXT_PUBLIC_APP_URL for redirects so the session cookie set on the
  // public domain stays addressable. Falls back to req.url for dev.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? reqUrl.origin;

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing+code", baseUrl));
  }

  const supabase = await server();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const target = new URL("/login", baseUrl);
    target.searchParams.set("error", error.message);
    return NextResponse.redirect(target);
  }

  return NextResponse.redirect(new URL(next, baseUrl));
}
