/**
 * middleware.ts — refreshes the Supabase session cookie on every request
 * so server components see fresh auth state, AND gates protected routes
 * by redirecting unauthenticated users to /login.
 *
 * Why redirect here instead of inside each page.tsx via `redirect()`?
 * On a full-page load, Next.js can't always convert a server-component
 * redirect into a 307 once streaming has begun (and our layout streams
 * immediately because of <Suspense> children) — the redirect arrives as
 * an RSC-only digest the browser doesn't follow on a hard load, so the
 * user sees the error.tsx fallback ("something broke") instead. Doing
 * the auth check here returns a real 307 every time.
 *
 * Excludes the OTLP ingest route (which authenticates with a PAT, not a
 * session cookie) and Next internals.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths that require an authenticated Supabase session. Sub-paths of
// these are also protected (e.g. /settings/tokens). Public paths like
// /, /login, /auth/*, /agent-onboard, /share/* (peer-share viewer),
// /api/* (PAT/cron-secret authed) are intentionally absent.
export const PROTECTED_PREFIXES = [
  "/app",
  "/projects",
  "/settings",
  "/billing",
  "/ask",
  "/github",
] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.next({ request: { headers: req.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Auth is optional for the v0.1 dogfood loop. If env isn't configured
    // (e.g. dev without Supabase), short-circuit so the rest of the app
    // still works.
    return res;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  if (!user && isProtectedPath(req.nextUrl.pathname)) {
    // Preserve the originally-requested path as ?next= so we can deep-link
    // post-login. /login validates this before honoring it.
    const loginUrl = new URL("/login", req.url);
    const nextParam = req.nextUrl.pathname + req.nextUrl.search;
    if (nextParam && nextParam !== "/") {
      loginUrl.searchParams.set("next", nextParam);
    }
    const redirect = NextResponse.redirect(loginUrl);
    // Carry over any session-refresh cookies supabase staged on `res`.
    for (const c of res.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Skip:
     *   - _next internals
     *   - the OTLP ingest path (PAT auth, not cookie auth)
     *   - static asset extensions
     *
     * NOTE: We still RUN the middleware on / (the public landing) so the
     * Supabase session cookie gets refreshed for any logged-in visitor —
     * the landing page itself doesn't gate on auth, but if a logged-in
     * user lands here we want their cookie fresh for the next /app hop.
     */
    "/((?!_next/|api/otlp/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
