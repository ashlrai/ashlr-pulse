/**
 * /auth/callback — OAuth/magic-link redirect target.
 *
 * Exchanges the `code` query param for a session cookie, then hands the
 * user back to the dashboard. Errors fall back to /login with the
 * Supabase error surfaced.
 *
 * Why we instantiate the Supabase client inline (not via lib/supabase-server's
 * `server()`): in a Route Handler that returns a custom NextResponse, cookies
 * staged via `cookies()` from next/headers don't always make it onto the
 * returned response — the new response object is separate. The session cookie
 * silently goes missing and the user lands on /app unauthenticated. Writing
 * directly to `response.cookies` guarantees the sb-* cookies ride along on
 * the 307 we return.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

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

  // Build the success-redirect response upfront so the supabase client can
  // write the freshly-minted session cookies directly onto it.
  const response = NextResponse.redirect(new URL(next, baseUrl));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    return NextResponse.redirect(new URL("/login?error=auth+not+configured", baseUrl));
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnon, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          response.cookies.set({ name, value, ...options });
        }
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const target = new URL("/login", baseUrl);
    target.searchParams.set("error", error.message);
    return NextResponse.redirect(target);
  }

  return response;
}
