/**
 * POST /api/cron/digest-weekly — weekly digest sweep.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), same
 * pattern as /api/cron/digest.
 *
 * Fires: Monday 9am in each user's local timezone (the caller — typically
 * a Railway/Vercel cron — should tick this every 15 min so every timezone
 * is caught; the pickDueUsersWeekly() query gates on dow=Monday AND hour>=9
 * AND last_weekly_digest_sent_at < this-Monday-9am).
 *
 * For MVP, orgs without a digest_frequency preference default to 'daily',
 * so shouldSendDigest('weekly', org.digest_frequency) returns false for them
 * and they are silently skipped. Only orgs that have opted into 'weekly' or
 * 'both' receive the weekly email.
 *
 * Content differences vs daily:
 *   - 7-day activity window instead of 1-day
 *   - WoW deltas (tokens / cost / events vs previous 7 days)
 *   - Top 3 anomalies from the 7-day window
 *   - End-of-month cost forecast
 *   - Peer-share section still fires (filtered by grant granularity)
 */

import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import {
  buildDigest,
  markWeeklyDigestSent,
  pickDueUsersWeekly,
  shouldSendDigest,
} from "@/lib/digest";
import { renderDigestEmail } from "@/lib/digest-render";
import { briefingForDigest } from "@/lib/briefing";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";
import { primaryOrgForUser } from "@/lib/org-db";

export const runtime = "nodejs";
export const maxDuration = 300;

interface PerUserResult {
  user_id: string;
  email: string;
  status: "sent" | "skipped" | "error" | "empty" | "frequency_skip";
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
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();
  const due = await pickDueUsersWeekly(now);
  log.info({ msg: "cron: digest-weekly starting", candidates: due.length });

  const results: PerUserResult[] = [];
  for (const u of due) {
    try {
      // Check org's digest_frequency — skip if not opted into weekly.
      const org = await primaryOrgForUser(u.id);
      const orgFrequency = org?.digest_frequency ?? "daily";
      if (!shouldSendDigest("weekly", orgFrequency)) {
        results.push({ user_id: u.id, email: u.email, status: "frequency_skip", detail: `org frequency: ${orgFrequency}` });
        continue;
      }

      const payload = await buildDigest(u.id, now, undefined, "weekly");
      if (!payload) {
        results.push({ user_id: u.id, email: u.email, status: "error", detail: "user vanished" });
        continue;
      }

      if (payload.empty) {
        await markWeeklyDigestSent(u.id, now);
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
        await markWeeklyDigestSent(u.id, now);
        results.push({ user_id: u.id, email: payload.email, status: "sent", detail: r.id });
      } else if ("skipped" in r) {
        results.push({ user_id: u.id, email: payload.email, status: "skipped", detail: r.reason });
      } else {
        results.push({ user_id: u.id, email: payload.email, status: "error", detail: `${r.status}: ${r.error}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ msg: "cron: digest-weekly user threw", user_id: u.id, err: msg });
      results.push({ user_id: u.id, email: u.email, status: "error", detail: msg });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  const summary = {
    sent:           results.filter((r) => r.status === "sent").length,
    empty:          results.filter((r) => r.status === "empty").length,
    skipped:        results.filter((r) => r.status === "skipped").length,
    frequency_skip: results.filter((r) => r.status === "frequency_skip").length,
    error:          results.filter((r) => r.status === "error").length,
  };
  log.info({ msg: "cron: digest-weekly done", elapsed_ms, ...summary });

  return NextResponse.json({
    ok: true,
    candidates: due.length,
    elapsed_ms,
    ...summary,
  });
}
