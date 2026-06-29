/**
 * POST /api/cron/fleet-scorecard-webhook — daily fleet scorecard webhook sink.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to all other /api/cron/* routes. Internal endpoint; not user-facing.
 *
 * Per run (fired daily at 02:30 UTC, after fleet-daily aggregates at 01:00 UTC):
 *   1. Finds every org that has a webhook_url configured.
 *   2. For each org, calls computeFleetMetrics for yesterday.
 *   3. Evaluates each event condition the org has subscribed to.
 *   4. If any events fired, POSTs a JSON payload signed with
 *      HMAC-SHA256(secret, body) to the org's webhook_url.
 *   5. Retries on 5xx up to 3 times with exponential backoff.
 *
 * Payload shape (privacy floor: metadata only, no prompts/code/diffs):
 *   { event, org_id, window, metrics_snapshot, threshold, actual, triggered_at }
 *
 * Idempotent: safe to trigger manually or re-run. Each invocation recomputes
 * yesterday's metrics — no state is mutated. Double-fires to the external
 * endpoint are possible on re-run but are benign (idempotent by event slug +
 * triggered_at on the receiver side).
 *
 * Per-org errors are swallowed (best-effort); the route returns 200 even on
 * partial delivery failure so the cron caller doesn't retry the full sweep.
 *
 * Scheduled: vercel.json / Railway cron — "30 2 * * *" (02:30 UTC daily,
 * after fleet-daily aggregates at 01:00 UTC).
 * In-process: registered in lib/cron.ts alongside the other daily ticks.
 */

import { NextResponse } from "next/server";
import { computeFleetMetrics } from "@/lib/fleet-oversight";
import {
  buildMetricsSnapshot,
  evaluateWebhookEvents,
  deliverWebhook,
  type WebhookPayload,
} from "@/lib/fleet-scorecard-webhook";
import { listOrgsWithWebhook, getOrgWebhookSecret } from "@/lib/webhook-db";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 5 minutes for large fleets

interface OrgResult {
  org_id: string;
  events_fired: number;
  deliveries_ok: number;
  deliveries_fail: number;
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
  const triggeredAt = new Date().toISOString();
  log.info({ msg: "cron: fleet-scorecard-webhook starting" });

  // Find all orgs with a webhook configured.
  const orgs = await listOrgsWithWebhook();
  log.info({ msg: "cron: fleet-scorecard-webhook orgs with webhook", count: orgs.length });

  const results: OrgResult[] = [];
  let totalDeliveriesOk = 0;
  let totalDeliveriesFail = 0;

  for (const { org_id, webhook_url, webhook_events } of orgs) {
    const orgResult: OrgResult = {
      org_id,
      events_fired: 0,
      deliveries_ok: 0,
      deliveries_fail: 0,
    };

    try {
      // Compute yesterday's fleet metrics (1-day window).
      const metrics = await computeFleetMetrics(org_id, 1);
      const snapshot = buildMetricsSnapshot(metrics);

      // Evaluate which subscribed events fired.
      const fired = evaluateWebhookEvents(snapshot, webhook_events);
      orgResult.events_fired = fired.length;

      if (fired.length === 0) {
        log.info({ msg: "cron: fleet-scorecard-webhook: no events fired", org_id });
        results.push(orgResult);
        continue;
      }

      // Fetch the signing secret on-demand, only now that we know a delivery
      // will happen. Keeps the secret out of the bulk org list and minimizes
      // its lifetime in memory to the window around HMAC signing.
      const webhook_secret = await getOrgWebhookSecret(org_id);

      // Deliver one POST per fired event.
      for (const { event, threshold, actual } of fired) {
        const payload: WebhookPayload = {
          event,
          org_id,
          window: metrics.window,
          metrics_snapshot: snapshot,
          threshold,
          actual,
          triggered_at: triggeredAt,
        };

        const result = await deliverWebhook(webhook_url, payload, webhook_secret);

        if (result.ok) {
          orgResult.deliveries_ok++;
          totalDeliveriesOk++;
          log.info({
            msg: "cron: fleet-scorecard-webhook: delivered",
            org_id,
            event,
            status: result.status,
            attempt: result.attempt,
          });
        } else {
          orgResult.deliveries_fail++;
          totalDeliveriesFail++;
          log.error({
            msg: "cron: fleet-scorecard-webhook: delivery failed",
            org_id,
            event,
            status: result.status,
            attempt: result.attempt,
            error: result.error,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({
        msg: "cron: fleet-scorecard-webhook: org threw",
        org_id,
        err: msg,
      });
    }

    results.push(orgResult);
  }

  const elapsed_ms = Date.now() - startedAt;
  const orgs_evaluated = results.length;
  const orgs_fired = results.filter((r) => r.events_fired > 0).length;

  log.info({
    msg: "cron: fleet-scorecard-webhook done",
    elapsed_ms,
    orgs_evaluated,
    orgs_fired,
    deliveries_ok: totalDeliveriesOk,
    deliveries_fail: totalDeliveriesFail,
  });

  // Aggregate counts only — no org IDs or webhook URLs in the HTTP response
  // (cron callers log response bodies; we must not leak endpoint URLs).
  return NextResponse.json({
    ok: true,
    elapsed_ms,
    orgs_evaluated,
    orgs_fired,
    deliveries_ok: totalDeliveriesOk,
    deliveries_fail: totalDeliveriesFail,
  });
}
