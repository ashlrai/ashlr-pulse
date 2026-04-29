/**
 * POST /api/cron/digest — daily digest sweep.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), same
 * pattern as /api/cron/github-sync. Internal endpoint, not user-facing.
 *
 * Per tick (every 15 min from lib/cron.ts in production):
 *   1. Pick users where digest_enabled = true AND it's >= 9am in their TZ
 *      AND last_digest_sent_at < today_local_9am.
 *   2. For each, build the digest payload (yesterday's activity + peer
 *      grants that fire today), render, send via SendGrid, mark sent.
 *
 * If SENDGRID_API_KEY is unset (typical in dev), individual sends return
 * `{ skipped: true }` and we log without marking the user as sent — that
 * way prod can be flipped on without backfill drift.
 *
 * Per-user errors are captured in the response (200 with details) so the
 * caller can see partial success; we only 5xx on configuration faults.
 */

import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import {
  buildDigest,
  markDigestSent,
  pickDueUsers,
} from "@/lib/digest";
import { renderDigestEmail } from "@/lib/digest-render";
import { briefingForDigest } from "@/lib/briefing";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const maxDuration = 300;

interface PerUserResult {
  user_id: string;
  email: string;
  status: "sent" | "skipped" | "error" | "empty";
  detail?: string;
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  // Constant-time compare: !== short-circuits and leaks the secret
  // byte-by-byte to an attacker measuring response timing.
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();
  const due = await pickDueUsers(now);
  log.info({ msg: "cron: digest starting", candidates: due.length });

  const results: PerUserResult[] = [];
  for (const u of due) {
    try {
      const payload = await buildDigest(u.id, now);
      if (!payload) {
        results.push({ user_id: u.id, email: u.email, status: "error", detail: "user vanished" });
        continue;
      }

      // Empty digests still mark the user as sent so we don't try again
      // until tomorrow — but we don't actually send the email.
      if (payload.empty) {
        await markDigestSent(u.id, now);
        results.push({ user_id: u.id, email: payload.email, status: "empty" });
        continue;
      }

      const briefing = await briefingForDigest(payload);
      const rendered = renderDigestEmail(payload, { briefing });
      const r = await sendEmail({
        to: payload.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      if (r.ok) {
        await markDigestSent(u.id, now);
        results.push({ user_id: u.id, email: payload.email, status: "sent", detail: r.id });
      } else if ("skipped" in r) {
        // Don't mark sent — prod will pick this up tomorrow once SendGrid is wired.
        results.push({ user_id: u.id, email: payload.email, status: "skipped", detail: r.reason });
      } else {
        results.push({ user_id: u.id, email: payload.email, status: "error", detail: `${r.status}: ${r.error}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ msg: "cron: digest user threw", user_id: u.id, err: msg });
      results.push({ user_id: u.id, email: u.email, status: "error", detail: msg });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  const summary = {
    sent: results.filter((r) => r.status === "sent").length,
    empty: results.filter((r) => r.status === "empty").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    error: results.filter((r) => r.status === "error").length,
  };
  log.info({ msg: "cron: digest done", elapsed_ms, ...summary });

  // Per-user details (emails, errors) go to the structured log only —
  // we don't put them in the HTTP response. Cron callers (Railway,
  // GitHub Actions) often log response bodies wholesale, and anyone
  // with PULSE_CRON_SECRET would otherwise be able to enumerate every
  // active digest user via the response.
  return NextResponse.json({
    ok: true,
    candidates: due.length,
    elapsed_ms,
    ...summary,
  });
}
