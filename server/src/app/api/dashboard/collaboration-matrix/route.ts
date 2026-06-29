/**
 * GET /api/dashboard/collaboration-matrix
 *
 * Returns the peer collaboration matrix for the heatmap tab.
 *
 * Query params:
 *   ?userId=<uuid>     — required; the authenticated user's ID (viewer).
 *   ?windowDays=1-30   — rolling window in days (default 7, max 30).
 *   ?status=active_grants|active_work|all — peer filter (default active_grants).
 *   ?model=<string>    — optional model filter (exact match).
 *   ?repo=<string>     — optional repo LIKE filter.
 *   ?format=csv        — return CSV instead of JSON.
 *
 * Auth: caller must be authenticated. The userId param must match the
 * authenticated user's ID (no impersonation without a grant). Peer-share
 * grants are enforced by computeCollaborationMatrix — revoked grants produce
 * no data.
 *
 * Privacy floor: only numeric aggregates are returned — no prompts, code,
 * or individual event content. Peer emails are masked server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import {
  computeCollaborationMatrix,
  matrixToCsv,
  type CollaborationMatrixFilter,
} from "@/lib/team-collaboration-matrix";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set<string>(["active_grants", "active_work", "all"]);

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;

  // Validate userId — must match the authenticated user (no cross-user leakage).
  const userId = params.get("userId");
  if (!userId || userId !== me.id) {
    return NextResponse.json(
      { error: "userId must match the authenticated user" },
      { status: 403 },
    );
  }

  // windowDays: 1–30
  const rawDays = parseInt(params.get("windowDays") ?? "7", 10);
  const windowDays = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(rawDays, 30))
    : 7;

  // peerStatus filter
  const rawStatus = params.get("status") ?? "active_grants";
  const peerStatus = ALLOWED_STATUSES.has(rawStatus)
    ? (rawStatus as CollaborationMatrixFilter["peerStatus"])
    : "active_grants";

  const model = params.get("model") ?? null;
  const repo  = params.get("repo")  ?? null;
  const format = params.get("format") ?? "json";

  log.info({
    msg:       "collaboration-matrix: loading",
    viewer_id: me.id,
    windowDays,
    peerStatus,
    model,
    repo,
    format,
  });

  try {
    const matrix = await computeCollaborationMatrix({
      viewerId: me.id,
      windowDays,
      peerStatus,
      model: model ?? undefined,
      repo:  repo  ?? undefined,
    });

    if (format === "csv") {
      const csv = matrixToCsv(matrix);
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="collaboration-matrix.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(matrix, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    log.error({ msg: "collaboration-matrix: error", err: String(e) });
    return NextResponse.json(
      { error: "Failed to compute collaboration matrix" },
      { status: 500 },
    );
  }
}
