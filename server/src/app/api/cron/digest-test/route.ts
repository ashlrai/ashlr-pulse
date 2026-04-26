/**
 * POST /api/cron/digest-test — render a digest payload without sending.
 *
 * Cron-secret guarded (admin scope). Returns the same payload + rendered
 * HTML/text/subject the cron would send for the given user, without
 * marking them as sent and without hitting Resend. Useful for:
 *   - Verifying yesterday's digest will look right before tomorrow's send
 *   - Debugging "why did Mason's cofounder's digest look weird?"
 *   - Iterating on the renderer template against live data
 *
 * Body: { user_id?: string, email?: string }
 *   - exactly one required
 *   - user_id takes precedence
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { buildDigest } from "@/lib/digest";
import { renderDigestEmail } from "@/lib/digest-render";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  user_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
}).refine((v) => Boolean(v.user_id || v.email), {
  message: "supply user_id or email",
});

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "PULSE_CRON_SECRET not configured" }, { status: 500 });
  }
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const db = sql();
  let userId = parsed.user_id;
  if (!userId && parsed.email) {
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM "user" WHERE email = ${parsed.email} LIMIT 1
    `;
    if (!row) return NextResponse.json({ error: "no user with that email" }, { status: 404 });
    userId = row.id;
  }
  if (!userId) {
    return NextResponse.json({ error: "missing user_id" }, { status: 400 });
  }

  const payload = await buildDigest(userId);
  if (!payload) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  const rendered = renderDigestEmail(payload);

  return NextResponse.json({
    payload,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}
