/**
 * middleware.ts — refreshes the Supabase session cookie on every request
 * so server components see fresh auth state. Required for @supabase/ssr.
 *
 * Excludes the OTLP ingest route (which authenticates with a PAT, not a
 * session cookie) and Next internals.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  await supabase.auth.getUser();
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
