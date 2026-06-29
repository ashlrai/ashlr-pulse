/**
 * GET /api/sessions/[id]/attribution — cost attribution waterfall for one session.
 *
 * Queries activity_event for the session_id, groups by tool_calls_types[0] and
 * model, computes cost aggregates, and returns a structured breakdown used by
 * the SessionAttributionWaterfall chart component.
 *
 * Query params:
 *   format=csv  — returns a CSV download instead of JSON
 *
 * Response JSON shape: SessionAttributionPayload (see lib/session-attribution.ts)
 *
 * Privacy floor: aggregated metadata only — no prompts, completions, or code.
 *
 * Auth: cookie session (currentUser). Only the session owner can access.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { log, requestId } from "@/lib/logger";
import {
  computeSessionAttribution,
  attributionToCsv,
  type RawSessionSpan,
} from "@/lib/session-attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rid = requestId(req);

  // ── Auth ────────────────────────────────────────────────────────────────────
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  const { id: sessionId } = await ctx.params;
  if (!sessionId) {
    return NextResponse.json(
      { error: "session id required" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // ── Query spans ─────────────────────────────────────────────────────────────
  const db = sql();
  const rows = await db.unsafe<RawSessionSpan[]>(
    `
    SELECT
      ts::text                                   AS ts,
      duration_ms,
      tool_calls_types,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      cost_millicents::float8                    AS cost_millicents,
      repo_name,
      source,
      model
    FROM activity_event
    WHERE user_id    = $1::uuid
      AND session_id = $2
      AND ts >= NOW() - INTERVAL '90 days'
    ORDER BY ts ASC
    LIMIT 500
    `,
    [me.id, sessionId],
  ).catch((err: unknown) => {
    log.error({ rid, err, sessionId }, "session-attribution: db query failed");
    return [] as RawSessionSpan[];
  });

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "session not found" },
      { status: 404, headers: { "x-request-id": rid } },
    );
  }

  // ── Compute attribution ─────────────────────────────────────────────────────
  const payload = computeSessionAttribution(sessionId, rows);

  // ── CSV download ────────────────────────────────────────────────────────────
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const csv = attributionToCsv(payload);
    const filename = `session-attribution-${sessionId.slice(0, 8)}.csv`;
    log.info({ rid, userId: me.id, sessionId, rows: rows.length }, "session-attribution/csv: ok");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "x-request-id":        rid,
        "Cache-Control":       "no-store",
      },
    });
  }

  log.info({ rid, userId: me.id, sessionId, spans: rows.length }, "session-attribution: ok");
  return NextResponse.json(payload, {
    headers: { "x-request-id": rid, "Cache-Control": "no-store" },
  });
}
