/**
 * GET /api/billing/export — CSV export of project-scoped AI usage for invoicing.
 *
 * Auth: cookie session (currentUser) + plan-gate (Pro+ only).
 *
 * Query params:
 *   projectId — UUID of the project to export (required)
 *   since     — ISO date string, lower bound (required)
 *   until     — ISO date string, upper bound (required)
 *
 * Response: streams text/csv attachment with filename:
 *   engagement-{projectId}-{since}-{until}.csv
 *
 * Columns: date | repo | model | hours_worked | tokens_input |
 *          tokens_output | cost_usd | event_count
 *
 * Privacy floor: only SHAREABLE_FIELDS used — no prompts, completions,
 * or raw OTel spans. See lib/billing-export.ts for column details.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { PlanGateError, requirePlan } from "@/lib/plan-gate";
import { getProjectByIdForUser } from "@/lib/project-db";
import { log, requestId } from "@/lib/logger";
import {
  aggregateBillingExport,
  billingCsvHeader,
  billingCsvRow,
} from "@/lib/billing-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow up to 5 min for large exports.
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

  // ── Plan gate: Pro+ only ─────────────────────────────────────────────────
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

  // ── Parse + validate query params ────────────────────────────────────────
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const sinceISO = url.searchParams.get("since");
  const untilISO = url.searchParams.get("until");

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }
  if (!sinceISO || !untilISO) {
    return NextResponse.json(
      { error: "since and until are required" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // Validate date strings.
  if (Number.isNaN(new Date(sinceISO).getTime()) || Number.isNaN(new Date(untilISO).getTime())) {
    return NextResponse.json(
      { error: "since and until must be valid ISO date strings" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // ── Verify project membership ────────────────────────────────────────────
  const project = await getProjectByIdForUser(projectId, me.id);
  if (!project) {
    return NextResponse.json(
      { error: "project not found" },
      { status: 404, headers: { "x-request-id": rid } },
    );
  }

  log.info({
    msg: "billing export started",
    request_id: rid,
    org_id: org.id,
    user_id: me.id,
    project_id: projectId,
    since: sinceISO,
    until: untilISO,
  });

  // ── Build CSV stream ──────────────────────────────────────────────────────
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(billingCsvHeader() + "\n"));

        const records = await aggregateBillingExport({
          projectId,
          sinceISO,
          untilISO,
        });

        let chunk = "";
        for (const rec of records) {
          chunk += billingCsvRow(rec) + "\n";
          // Flush every 500 rows to keep memory pressure low.
          if (chunk.length > 64_000) {
            controller.enqueue(encoder.encode(chunk));
            chunk = "";
          }
        }
        if (chunk) controller.enqueue(encoder.encode(chunk));

        controller.close();

        log.info({
          msg: "billing export complete",
          request_id: rid,
          org_id: org.id,
          user_id: me.id,
          project_id: projectId,
          row_count: records.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({
          msg: "billing export error",
          request_id: rid,
          org_id: org.id,
          err: msg,
        });
        controller.error(err);
      }
    },
  });

  // Sanitize projectId for use in filename (keep only safe chars).
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9-]/g, "-");
  const safeSince = sinceISO.slice(0, 10);
  const safeUntil = untilISO.slice(0, 10);
  const filename = `engagement-${safeProjectId}-${safeSince}-${safeUntil}.csv`;

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "x-request-id": rid,
      "Cache-Control": "no-store",
    },
  });
}
