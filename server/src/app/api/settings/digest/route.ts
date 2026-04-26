/**
 * POST /api/settings/digest — update the current user's digest preferences.
 *
 * Body (all optional):
 *   { enabled?: boolean, tz?: string, email?: string | null }
 *
 * `tz` is validated as a real IANA zone via Intl. `email` null clears the
 * override (digest then falls back to the auth email).
 *
 * GET on the same path returns the user's current prefs — used by the
 * settings page when it loads.
 *
 * Auth: Supabase session via currentUser(). 401 if missing.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";

export const runtime = "nodejs";

const Body = z.object({
  enabled: z.boolean().optional(),
  tz: z.string().min(1).max(80).optional(),
  email: z.union([z.string().email(), z.null()]).optional(),
});

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = sql();
  const [row] = await db<{
    digest_enabled: boolean;
    digest_tz: string;
    digest_email: string | null;
    last_digest_sent_at: string | null;
  }[]>`
    SELECT digest_enabled, digest_tz, digest_email, last_digest_sent_at::text AS last_digest_sent_at
    FROM "user" WHERE id = ${me.id}::uuid
  `;
  if (!row) return NextResponse.json({ error: "user not found" }, { status: 404 });
  return NextResponse.json({
    enabled: row.digest_enabled,
    tz: row.digest_tz,
    email: row.digest_email,
    fallback_email: me.email,
    last_sent_at: row.last_digest_sent_at,
  });
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  if (parsed.tz !== undefined && !validTz(parsed.tz)) {
    return NextResponse.json({ error: `unknown timezone: ${parsed.tz}` }, { status: 422 });
  }

  const db = sql();
  // Apply each field independently so an unset key is a true no-op
  // (vs. null-meaning-clear for digest_email, which we DO want to honor).
  if (parsed.enabled !== undefined) {
    await db`UPDATE "user" SET digest_enabled = ${parsed.enabled} WHERE id = ${me.id}::uuid`;
  }
  if (parsed.tz !== undefined) {
    await db`UPDATE "user" SET digest_tz = ${parsed.tz} WHERE id = ${me.id}::uuid`;
  }
  if (parsed.email !== undefined) {
    await db`UPDATE "user" SET digest_email = ${parsed.email} WHERE id = ${me.id}::uuid`;
  }
  return NextResponse.json({ ok: true });
}
