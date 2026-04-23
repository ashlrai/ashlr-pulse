/**
 * POST /api/otlp/v1/traces — OTLP/HTTP-JSON ingest.
 *
 * Accepts a standard OTLP/HTTP traces payload. Walks every span, maps
 * GenAI-shaped ones to activity_event rows, bulk-inserts.
 *
 * Dogfood setup (v0.1 single-user):
 *   export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3000/api/otlp/v1/traces
 *   export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   claude ...
 *
 * Auth: v0.1 takes a user id from the `x-ashlr-user` header. v0.2 swaps
 * this for real auth via Clerk/Supabase — tracked in ROADMAP Phase 0.2.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { spanToActivityEvent } from "@/lib/otel-genai";
import type { OtlpTracesPayload } from "@/lib/otlp-types";

export const runtime = "nodejs";

const DEV_USER_FALLBACK = "dev-local";

export async function POST(req: Request): Promise<Response> {
  const userId = req.headers.get("x-ashlr-user") ?? DEV_USER_FALLBACK;

  let payload: OtlpTracesPayload;
  try {
    payload = (await req.json()) as OtlpTracesPayload;
  } catch {
    return NextResponse.json({ error: "invalid OTLP JSON" }, { status: 400 });
  }

  const rows = collectRows(payload, userId);
  if (rows.length === 0) {
    // OTLP spec: return 200 even on no-op so exporters don't retry.
    return NextResponse.json({ partialSuccess: { rejectedSpans: 0 } });
  }

  const db = sql();
  try {
    // postgres-js understands plain objects and handles array<->TEXT[] for
    // tool_calls_types. Bulk insert via VALUES expansion.
    await db`
      INSERT INTO activity_event ${db(rows, [
        "ts",
        "user_id",
        "session_id",
        "source",
        "provider",
        "model",
        "duration_ms",
        "tokens_input",
        "tokens_output",
        "tokens_cache_read",
        "tokens_cache_write",
        "tool_calls_count",
        "tool_calls_types",
        "accepted_count",
        "rejected_count",
        "project_hash",
        "repo_name",
        "git_branch",
        "language",
        "raw_otel_span",
      ])}
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "db insert failed", detail: message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    partialSuccess: { rejectedSpans: 0 },
    accepted: rows.length,
  });
}

function collectRows(payload: OtlpTracesPayload, userId: string) {
  const out = [];
  for (const rs of payload.resourceSpans ?? []) {
    const scopeGroups = rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? [];
    for (const sg of scopeGroups) {
      for (const span of sg.spans ?? []) {
        const row = spanToActivityEvent(span, userId);
        if (row) out.push(row);
      }
    }
  }
  return out;
}
