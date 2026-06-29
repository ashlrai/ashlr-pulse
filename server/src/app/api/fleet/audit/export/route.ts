/**
 * GET /api/fleet/audit/export — streaming JSONL export of the fleet audit log.
 *
 * Auth: cookie session (currentUser) + plan-gate (Pro/Team only; map_enabled).
 *       Team orgs additionally support the `org` query-param to restrict by org
 *       (though the server always scopes to the user's primary org regardless —
 *       the param is just a UX filter within that scope).
 *
 * Query params:
 *   since  — ISO date string, lower bound (default: 90 days ago)
 *   until  — ISO date string, upper bound (default: now)
 *   repo   — filter to one repo full_name (optional)
 *   format — "jsonl" (default) | "csv" — controls Content-Type + filename
 *
 * Response: streams JSONL (one JSON object per line) or CSV (header + rows).
 * Uses ReadableStream + TransformStream so large exports don't OOM the server —
 * each DB batch is flushed to the client as soon as it's ready.
 *
 * Privacy floor:
 *   • All rows pass through sanitizeDetail (fleet-audit.ts) via the lib.
 *   • proposal_summary_hash is SHA-256 of the row id — never the proposal text.
 *   • Exports are Pro+ only (peer-share rules; map_enabled gate).
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor, PlanGateError, requirePlan } from "@/lib/plan-gate";
import { log, requestId } from "@/lib/logger";
import {
  streamAuditExport,
  csvHeader,
  csvRow,
  type AuditExportRecord,
} from "@/lib/fleet-audit-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow up to 5 min for a large streaming export.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const rid = requestId(req);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  const org = await primaryOrgForUser(me.id);
  if (!org) {
    return NextResponse.json(
      { error: "no org" },
      { status: 403, headers: { "x-request-id": rid } },
    );
  }

  // ── Plan gate: Pro/Team only (map_enabled = peer-share rules) ────────────
  try {
    requirePlan(org, "pro");
  } catch (err) {
    if (err instanceof PlanGateError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: { "x-request-id": rid } },
      );
    }
    throw err;
  }
  if (!limitsFor(org).map_enabled) {
    return NextResponse.json(
      { error: "upgrade to Pro to export the audit log" },
      { status: 402, headers: { "x-request-id": rid } },
    );
  }

  // ── Parse query params ────────────────────────────────────────────────────
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const repo = url.searchParams.get("repo");
  const format = url.searchParams.get("format") === "csv" ? "csv" : "jsonl";

  log.info({
    msg: "fleet audit export started",
    request_id: rid,
    org_id: org.id,
    user_id: me.id,
    format,
    since,
    until,
    repo,
  });

  // ── Stream ────────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const generator = streamAuditExport(org.id, { since, until, repo });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode(csvHeader() + "\n"));
        }

        for await (const batch of generator) {
          let chunk = "";
          for (const rec of batch) {
            if (format === "csv") {
              chunk += csvRow(rec) + "\n";
            } else {
              chunk += JSON.stringify(rec) + "\n";
            }
          }
          if (chunk) controller.enqueue(encoder.encode(chunk));
        }

        controller.close();

        log.info({
          msg: "fleet audit export complete",
          request_id: rid,
          org_id: org.id,
          user_id: me.id,
          format,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({
          msg: "fleet audit export error",
          request_id: rid,
          org_id: org.id,
          err: msg,
        });
        controller.error(err);
      }
    },
  });

  const contentType =
    format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson";
  const ext = format === "csv" ? "csv" : "jsonl";
  const filename = `fleet-audit-${new Date().toISOString().slice(0, 10)}.${ext}`;

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "x-request-id": rid,
      // No caching — each export is a live snapshot.
      "Cache-Control": "no-store",
    },
  });
}
