/**
 * supabase-server.ts — server-side Supabase client factories.
 *
 * Two flavors:
 *
 *   - server() : RSC / route handler client. Reads/writes cookies via
 *                next/headers. Use for everything that runs in a request
 *                context (page.tsx, route.ts, server actions).
 *
 *   - admin()  : service-role client. Bypasses RLS. Only call from trusted
 *                server code (e.g. PAT validation). NEVER expose responses
 *                from this client to a viewer who shouldn't see them.
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY    (admin-only — never include the prefix
 *                                 NEXT_PUBLIC_)
 */

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function server() {
  const cookieStore = await cookies();
  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          // In RSCs (page.tsx) cookieStore.set throws — that's fine, the
          // middleware refreshes the session on the next request.
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            /* RSC context — ignore. */
          }
        },
      },
    },
  );
}

let _admin: ReturnType<typeof createClient> | null = null;
export function admin() {
  if (_admin) return _admin;
  _admin = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return _admin;
}
