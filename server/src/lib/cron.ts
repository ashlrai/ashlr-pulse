/**
 * cron.ts — in-process scheduler.
 *
 * Registered once at Next.js boot via instrumentation.ts. Three ticks:
 *   - github-sync, hourly: POST /api/cron/github-sync
 *   - digest, every 15 min: POST /api/cron/digest
 *   - oversight, daily: POST /api/cron/oversight (manager-agent scorecards)
 *
 * Both pass PULSE_CRON_SECRET. Hitting the HTTP endpoint (rather than
 * importing the handler directly) keeps the auth surface uniform —
 * external triggers and the in-process trigger go through the same
 * authorization check.
 *
 * Why not setInterval against a direct function call? Two reasons:
 *   1. Single auth path — easier to reason about, easier to test
 *      (one curl smoke-tests both call sites).
 *   2. Next dev mode reloads modules a lot; an in-process direct
 *      handle could double-fire. The HTTP path is reload-safe — even
 *      if multiple registrations happen in dev, they all hit the
 *      same idempotent endpoint.
 *
 * Disabled when PULSE_CRON_SECRET isn't set (so dev doesn't run it).
 */

import { log } from "./logger";
import { incrCounter, recordTickResult } from "./metrics";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

let started = false;

export function startBackgroundCron(): void {
  if (started) return;
  started = true;

  const secret = process.env.PULSE_CRON_SECRET;
  if (!secret) {
    log.warn({ msg: "cron: PULSE_CRON_SECRET unset — background sync disabled" });
    return;
  }

  // Don't run in dev — Next reloads on every save; would double-fire.
  if (process.env.NODE_ENV !== "production") {
    log.info({ msg: "cron: NODE_ENV != production — skipping background sync" });
    return;
  }

  log.info({ msg: "cron: registering ticks", github_sync: "hourly", digest: "15m", oversight: "daily", fleet_daily: "daily", peer_share_refresh: "daily" });

  // Initial ticks staggered so we don't slam the DB at boot.
  setTimeout(() => tick("github-sync"),          2 * 60 * 1000);
  setTimeout(() => tick("digest"),               5 * 60 * 1000);
  setTimeout(() => tick("oversight"),            8 * 60 * 1000);
  setTimeout(() => tick("fleet-daily"),         11 * 60 * 1000);
  setTimeout(() => tick("peer-share-refresh"),  14 * 60 * 1000);

  setInterval(() => tick("github-sync"),          ONE_HOUR_MS);
  setInterval(() => tick("digest"),               FIFTEEN_MIN_MS);
  setInterval(() => tick("oversight"),            ONE_DAY_MS);
  setInterval(() => tick("fleet-daily"),          ONE_DAY_MS);
  setInterval(() => tick("peer-share-refresh"),   ONE_DAY_MS);
}

async function tick(endpoint: "github-sync" | "digest" | "oversight" | "fleet-daily" | "peer-share-refresh"): Promise<void> {
  const port = process.env.PORT ?? "3000";
  const url = `http://127.0.0.1:${port}/api/cron/${endpoint}`;
  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-cron-secret": process.env.PULSE_CRON_SECRET ?? "",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const duration_ms = Date.now() - startedAt;
    log.info({ msg: "cron: tick complete", endpoint, status: r.status, duration_ms });
    incrCounter(`cron.${endpoint}.${r.ok ? "ok" : "fail"}`);
    recordTickResult({ endpoint, status: r.status, duration_ms });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ msg: "cron: tick failed", endpoint, err: message, duration_ms });
    incrCounter(`cron.${endpoint}.error`);
    recordTickResult({ endpoint, status: null, duration_ms, error: message });
  }
}
