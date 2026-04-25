/**
 * POST /api/otlp/v1/traces — OTLP/HTTP-JSON ingest.
 *
 * Auth precedence:
 *   1. Bearer PAT  (Authorization: Bearer pulse_pat_…) — production-grade,
 *      used by the Rust agent and the ashlr-plugin emitter.
 *   2. x-ashlr-user header — dev-only fallback, accepted iff
 *      NODE_ENV !== "production". Lets the curl smoke loop in QUICKSTART.md
 *      keep working without minting a PAT.
 *
 * In production, missing/invalid auth returns 401. The OTLP spec says
 * exporters retry 4xx and that's correct here — they should retry after
 * the operator fixes the credential, not give up.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { spanToActivityEvent } from "@/lib/otel-genai";
import { verifyPat } from "@/lib/pat";
import type { OtlpTracesPayload } from "@/lib/otlp-types";

export const runtime = "nodejs";

async function resolveUserId(req: Request): Promise<string | null> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    return verifyPat(authz.slice(7).trim());
  }

  if (process.env.NODE_ENV !== "production") {
    const dev = req.headers.get("x-ashlr-user");
    if (dev) return dev;
  }

  return null;
}

export async function POST(req: Request): Promise<Response> {
  const userId = await resolveUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized: provide Authorization: Bearer pulse_pat_…" },
      { status: 401 },
    );
  }

  let payload: OtlpTracesPayload;
  try {
    payload = (await req.json()) as OtlpTracesPayload;
  } catch {
    return NextResponse.json({ error: "invalid OTLP JSON" }, { status: 400 });
  }

  const rows = collectRows(payload, userId);
  if (rows.length === 0) {
    return NextResponse.json({ partialSuccess: { rejectedSpans: 0 } });
  }

  const db = sql();
  try {
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
        "tokens_saved",
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
