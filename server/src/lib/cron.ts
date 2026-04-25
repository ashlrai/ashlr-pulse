/**
 * cron.ts — in-process hourly scheduler.
 *
 * Registered once at Next.js boot via instrumentation.ts. Calls the
 * `/api/cron/github-sync` endpoint over HTTP every 60 min, passing the
 * shared PULSE_CRON_SECRET. Hitting the HTTP endpoint (rather than
 * importing syncAllAccounts directly) keeps the auth surface uniform —
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

const ONE_HOUR_MS = 60 * 60 * 1000;

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

  log.info({ msg: "cron: registering hourly github-sync" });

  // Initial tick after 2 min so we don't slam the DB at boot — gives
  // the rest of the runtime time to finish migrations + warm up.
  setTimeout(tick, 2 * 60 * 1000);
  // Then on the hour, every hour.
  setInterval(tick, ONE_HOUR_MS);
}

async function tick(): Promise<void> {
  const port = process.env.PORT ?? "3000";
  const url = `http://127.0.0.1:${port}/api/cron/github-sync`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-cron-secret": process.env.PULSE_CRON_SECRET ?? "",
        "content-type": "application/json",
      },
      body: "{}",
    });
    log.info({ msg: "cron: tick complete", status: r.status });
  } catch (err) {
    log.error({ msg: "cron: tick failed", err: err instanceof Error ? err.message : String(err) });
  }
}
