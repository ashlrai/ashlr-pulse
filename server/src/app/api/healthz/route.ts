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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const body = {
    ok: dbOk,
    db: dbOk ? "ok" : "down",
    error: dbError,
    latency_ms: Date.now() - startedAt,
    llm: llmStatus(),  // { configured, provider, model } — no secrets
    ts: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
