/**
 * GET /api/healthz — liveness + readiness probe.
 *
 * Used by Railway's healthcheckPath. Returns 200 with a tiny JSON body
 * so the platform can shift traffic to a new deploy only after Next.js
 * has actually bound and the DB is reachable. We do a lightweight
 * `SELECT 1` so a deploy with a wedged DB connection fails its check.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { llmStatus } from "@/lib/llm";
import { metricsSnapshot } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Static probe for Supabase auth wiring: do NOT hit the auth.supabase.co
 * API on every healthcheck — that adds external dependency latency to a
 * Railway probe and rate-pressures Supabase. We only verify that the
 * URL + anon key are present and the URL is parseable. Callback
 * misconfiguration (wrong project, wrong domain) surfaces in the 'url'
 * field for ops-level inspection.
 */
function authStatus(): {
  configured: boolean;
  url: string | null;
  error: string | null;
} {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) {
    return {
      configured: false,
      url: null,
      error: !url
        ? "NEXT_PUBLIC_SUPABASE_URL not set"
        : "NEXT_PUBLIC_SUPABASE_ANON_KEY not set",
    };
  }
  // Parse the URL — catches typos like missing scheme, embedded whitespace.
  let host: string;
  try {
    host = new URL(url).host;
  } catch (err) {
    return {
      configured: false,
      url,
      error: `invalid NEXT_PUBLIC_SUPABASE_URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Service-role key is admin-only; flag missing as a soft warning rather
  // than fatal — only the PAT-validation path needs it today.
  return {
    configured: true,
    url: host,
    error: service ? null : "warn: SUPABASE_SERVICE_ROLE_KEY not set",
  };
}

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const db = sql();
    const [row] = await db<{ ok: number }[]>`SELECT 1 AS ok`;
    dbOk = row?.ok === 1;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const auth = authStatus();
  const body = {
    ok: dbOk,
    db: dbOk ? "ok" : "down",
    error: dbError,
    latency_ms: Date.now() - startedAt,
    auth,                // { configured, url, error } — never logs the key
    llm: llmStatus(),    // { configured, provider, model } — no secrets
    metrics: metricsSnapshot(), // counters + cron-tick ring; no PII
    ts: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
