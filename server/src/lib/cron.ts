/**
 * cron.ts — in-process scheduler.
 *
 * Registered once at Next.js boot via instrumentation.ts. Two ticks:
 *   - github-sync, hourly: POST /api/cron/github-sync
 *   - digest, every 15 min: POST /api/cron/digest
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
import { recordCronRun } from "./cron-runs";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

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

  log.info({ msg: "cron: registering ticks", github_sync: "hourly", digest: "15m" });

  // Initial ticks staggered so we don't slam the DB at boot.
  setTimeout(() => tick("github-sync"), 2 * 60 * 1000);
  setTimeout(() => tick("digest"),     5 * 60 * 1000);

  setInterval(() => tick("github-sync"), ONE_HOUR_MS);
  setInterval(() => tick("digest"),     FIFTEEN_MIN_MS);
}

async function tick(endpoint: "github-sync" | "digest"): Promise<void> {
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
    const elapsedMs = Date.now() - startedAt;
    log.info({ msg: "cron: tick complete", endpoint, status: r.status, elapsed_ms: elapsedMs });
    // Telemetry write is best-effort — never let a logging failure
    // mask a successful tick. The next tick will record again.
    recordCronRun({ endpoint, status: r.status, elapsedMs }).catch((err) => {
      log.error({ msg: "cron: telemetry write failed", endpoint, err: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ msg: "cron: tick failed", endpoint, err: message });
    recordCronRun({ endpoint, status: 0, elapsedMs, error: message }).catch(() => {
      // Swallow — already logged the original failure above.
    });
  }
}
