/**
 * GET /api/peer-share/subscribe
 *
 * Server-Sent Events (SSE) endpoint that streams hourly cost/token/event
 * deltas to a co-founder (viewer) watching an owner's spending in realtime.
 *
 * ─── Purpose ────────────────────────────────────────────────────────────────
 *
 * The daily aggregate cron runs once at 02:00 UTC — too stale for live
 * pair-programming sessions. This endpoint polls peer_share_hourly_aggregate
 * on a configurable interval (default: 15 s) and emits a `delta` SSE event
 * whenever the current-hour bucket has changed since the last push.
 *
 * Use-case: "what is my co-founder spending right now" during a pair session.
 *
 * ─── Auth / peer-share gate ─────────────────────────────────────────────────
 *
 * Query params:
 *   ?owner=<userId>   — required. The owner whose aggregates the caller wants
 *                       to subscribe to. The caller (viewer) must hold an
 *                       active non-revoked peer_share grant from that owner.
 *   ?interval=<ms>    — optional. Polling interval in milliseconds.
 *                       Clamped to [5_000, 60_000]. Default: 15_000.
 *
 * ─── Privacy floor ──────────────────────────────────────────────────────────
 *
 * Only aggregate numbers (cost_millicents, token counts, event_count) flow
 * through delta events — never prompts, completions, or raw OTel spans.
 * The underlying hourly aggregate table enforces this at compute time.
 *
 * ─── Delta event shape ──────────────────────────────────────────────────────
 *
 * Each SSE event carries a JSON array of PeerShareDeltaEvent:
 *   { type: "delta", ownerId, source, model, bucket, costDelta,
 *     tokenDelta, eventCount }
 *
 * Events are only emitted when at least one delta is non-zero.
 * A heartbeat comment (":\n\n") is sent every HEARTBEAT_MS to keep the
 * connection alive through proxies.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import {
  readHourlyRows,
  computeDeltas,
  type PeerShareHourlyAggregate,
} from "@/lib/peer-share-hourly-aggregate";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 20_000;

// ---------------------------------------------------------------------------
// Grant check
// ---------------------------------------------------------------------------

async function hasGrantFrom(viewerId: string, ownerId: string): Promise<boolean> {
  const grants = await listGrantsForViewer(viewerId);
  return grants.some((g) => g.owner_id === ownerId);
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ownerParam = req.nextUrl.searchParams.get("owner");
  if (!ownerParam) {
    return NextResponse.json(
      { error: "?owner=<userId> is required" },
      { status: 400 },
    );
  }

  // Peer-share grant check — viewer must hold an active grant from owner.
  const allowed = await hasGrantFrom(me.id, ownerParam);
  if (!allowed) {
    return NextResponse.json(
      { error: "no active peer-share grant from that owner" },
      { status: 403 },
    );
  }

  // Parse and clamp polling interval.
  const rawInterval = Number(req.nextUrl.searchParams.get("interval") ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, isFinite(rawInterval) ? rawInterval : DEFAULT_INTERVAL_MS),
  );

  log.info({
    msg: "peer-share-subscribe: SSE connection opened",
    viewer_id: me.id,
    owner_id: ownerParam,
    interval_ms: intervalMs,
  });

  const encoder = new TextEncoder();

  // Snapshot from the previous poll tick — used by computeDeltas().
  let prevSnapshot: PeerShareHourlyAggregate[] = [];

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Initial "connected" comment — triggers browser onopen.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const poll = async () => {
        try {
          // Read the last 2 hours so we pick up events that straddle an hour
          // boundary during the first tick after a bucket rolls over.
          const now = new Date();
          const fromBucket = new Date(now.getTime() - 2 * 3_600_000);

          const curr = await readHourlyRows(ownerParam, me.id, fromBucket, now);
          const deltas = computeDeltas(ownerParam, prevSnapshot, curr);

          if (deltas.length > 0) {
            const data = JSON.stringify(deltas);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }

          // Advance snapshot.
          prevSnapshot = curr;
        } catch (err) {
          log.error({
            msg: "peer-share-subscribe: poll error",
            viewer_id: me.id,
            owner_id: ownerParam,
            err: err instanceof Error ? err.message : String(err),
          });
          // Don't close the stream on a transient DB error — just skip this tick.
        }
      };

      // Run the first poll immediately so the client sees current state fast.
      await poll();

      // Schedule subsequent polls.
      pollTimer = setInterval(poll, intervalMs);

      // Heartbeat keeps idle connections alive through proxies.
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream closed.
        }
      }, HEARTBEAT_MS);
    },

    cancel() {
      if (pollTimer != null) clearInterval(pollTimer);
      if (heartbeatTimer != null) clearInterval(heartbeatTimer);

      log.info({
        msg: "peer-share-subscribe: SSE connection closed",
        viewer_id: me.id,
        owner_id: ownerParam,
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
