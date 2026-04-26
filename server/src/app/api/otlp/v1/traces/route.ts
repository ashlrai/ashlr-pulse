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
 * Task 6: per-PAT in-memory token bucket (60 req/min default).
 *   Rate limiting is skipped for the x-ashlr-user dev fallback.
 * Task 7: structured logging via pino. request_id echoed in responses.
 *   Bodies are never logged (privacy floor — may contain prompts).
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { spanToActivityEvent } from "@/lib/otel-genai";
import { verifyPat } from "@/lib/pat";
import { checkBucket } from "@/lib/rate-limit";
import { log, requestId } from "@/lib/logger";
import type { OtlpTracesPayload } from "@/lib/otlp-types";

export const runtime = "nodejs";

/**
 * Returns { userId, patKey } on success. patKey is null for the dev fallback
 * (rate limiting is skipped when patKey is null).
 */
async function resolveUserId(
  req: Request,
): Promise<{ userId: string; patKey: string | null } | null> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const token = authz.slice(7).trim();
    const userId = await verifyPat(token);
    if (!userId) return null;
    // Use first 26 chars of token as bucket key (prefix + 16 hex chars).
    // Never use the full token as a map key — keep the key non-reversible.
    const patKey = token.slice(0, 26);
    return { userId, patKey };
  }

  if (process.env.NODE_ENV !== "production") {
    const dev = req.headers.get("x-ashlr-user");
    if (dev) return { userId: dev, patKey: null };
  }

  return null;
}

export async function POST(req: Request): Promise<Response> {
  const rid = requestId(req);

  const auth = await resolveUserId(req);
  if (!auth) {
    log.warn({ msg: "otlp: unauthorized", request_id: rid });
    return NextResponse.json(
      { error: "unauthorized: provide Authorization: Bearer pulse_pat_…" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  const { userId, patKey } = auth;

  // Rate limiting (Task 6) — skip for dev fallback.
  if (patKey !== null) {
    const rl = checkBucket(patKey);
    if (!rl.ok) {
      log.warn({ msg: "otlp: rate limited", request_id: rid, user_id: userId });
      return NextResponse.json(
        { error: "rate limit exceeded" },
        {
          status: 429,
          headers: {
            "x-request-id": rid,
            "Retry-After": String(rl.retryAfterSec),
          },
        },
      );
    }
  }

  // Reject oversized payloads BEFORE buffering. The OTLP wire format
  // is dense; a legitimate batch from the Rust agent is well under 100KB.
  // 1 MB is generous and still bounds memory if a misbehaving client
  // (or a probe) tries to OOM the process.
  const MAX_BYTES = Number(process.env.PULSE_OTLP_MAX_BYTES ?? "1048576"); // 1 MB
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    log.warn({ msg: "otlp: payload too large (declared)", bytes: declared, request_id: rid, user_id: userId });
    return NextResponse.json(
      { error: `payload too large: ${declared} > ${MAX_BYTES}` },
      { status: 413, headers: { "x-request-id": rid } },
    );
  }

  // Parse payload — do NOT log body (privacy floor). Read the body as
  // text first so we can enforce the size cap when Content-Length is
  // missing or wrong (chunked transfer + lying clients).
  let payload: OtlpTracesPayload;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BYTES) {
      log.warn({ msg: "otlp: payload too large (actual)", bytes: raw.length, request_id: rid, user_id: userId });
      return NextResponse.json(
        { error: `payload too large: ${raw.length} > ${MAX_BYTES}` },
        { status: 413, headers: { "x-request-id": rid } },
      );
    }
    payload = JSON.parse(raw) as OtlpTracesPayload;
  } catch {
    log.warn({ msg: "otlp: invalid JSON", request_id: rid, user_id: userId });
    return NextResponse.json(
      { error: "invalid OTLP JSON" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  const rows = collectRows(payload, userId);
  if (rows.length === 0) {
    return NextResponse.json(
      { partialSuccess: { rejectedSpans: 0 } },
      { headers: { "x-request-id": rid } },
    );
  }

  const db = sql();
  let inserted = 0;
  try {
    // ON CONFLICT DO NOTHING handles the (user_id, span_id) unique index
    // from migration 0007 — agent retries after a flaky network round-trip
    // can't double-count tokens. Rows with span_id IS NULL (legacy / shell
    // hook spans) bypass the partial unique index and always insert.
    const result = await db`
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
        "span_id",
        "raw_otel_span",
      ])}
      ON CONFLICT DO NOTHING
    `;
    inserted = result.count ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ msg: "otlp: db insert failed", err: message, request_id: rid, user_id: userId, status: 500 });
    return NextResponse.json(
      { error: "db insert failed", detail: message },
      { status: 500, headers: { "x-request-id": rid } },
    );
  }

  const dedup = rows.length - inserted;
  log.info({ msg: "otlp: accepted", spans: rows.length, inserted, dedup, request_id: rid, user_id: userId });
  return NextResponse.json(
    { partialSuccess: { rejectedSpans: 0 }, accepted: rows.length, inserted, dedup },
    { headers: { "x-request-id": rid } },
  );
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
