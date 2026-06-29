/**
 * GET /api/fleet/cost-impact/subscribe
 *
 * Server-Sent Events (SSE) endpoint that streams 5-minute rolling cost windows
 * for the fleet cost-impact widget. Peer-share viewers receive cost attribution
 * broken down by fleet_event × fleet_outcome, with cost_delta / cost_vs_baseline
 * / variance_pct fields from FleetRealtimeEvent.
 *
 * ─── Cost window shape ──────────────────────────────────────────────────────
 *
 * Each SSE message carries a `CostImpactWindow`:
 *   windowStart     — ISO-8601 start of the 5-minute bucket
 *   windowEnd       — ISO-8601 end of the bucket
 *   buckets[]       — one entry per (fleet_event, fleet_outcome) pair seen in
 *                     the window, with summed cost fields
 *   totalMillicents — sum across all buckets
 *   baselineMillicents — team_avg_millicents from latest event (or 0)
 *   deltaMillicents — totalMillicents − baselineMillicents × event_count
 *   variancePct     — (deltaMillicents / (baselineMillicents × event_count)) × 100
 *
 * ─── Auth / peer-share scope ────────────────────────────────────────────────
 *
 * Query params:
 *   ?as=<userId>   — peer-share view: caller must hold an active grant from
 *                    <userId>. Events are filtered to the grant's scope.
 *
 * Without ?as, the subscriber watches their own events.
 *
 * ─── Privacy floor ──────────────────────────────────────────────────────────
 *
 * All fields are pure numeric aggregates. No prompts, completions, code, diffs,
 * or raw OTel spans. Only fleet_event + fleet_outcome strings (event-type labels
 * already approved in the FleetRealtimeEvent whitelist) appear.
 *
 * ─── Mechanism ──────────────────────────────────────────────────────────────
 *
 * Uses the same dashboard-sse-registry.ts infrastructure as
 * /api/dashboard/subscribe, but registers a CostImpactSseController that
 * aggregates incoming FleetRealtimeEvents into 5-minute windows before
 * flushing. The registry fan-out from pushFleetEvents() delivers raw events;
 * this endpoint folds them into windows and emits on each flush.
 *
 * ─── Feature flag ───────────────────────────────────────────────────────────
 *
 * Active when PULSE_REALTIME_PUSH=true (same flag as the dashboard subscribe
 * route). When absent the stream opens but no events are emitted.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import { log } from "@/lib/logger";
import { register, type SseController } from "@/lib/dashboard-sse-registry";
import type { FleetRealtimeEvent } from "@/lib/fleet-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Cost-impact window shape
// ---------------------------------------------------------------------------

export interface CostImpactBucket {
  fleet_event: string;
  fleet_outcome: string;
  event_count: number;
  total_millicents: number;
  avg_delta_millicents: number;
  avg_variance_pct: number;
}

export interface CostImpactWindow {
  windowStart: string;
  windowEnd: string;
  buckets: CostImpactBucket[];
  totalMillicents: number;
  baselineMillicents: number;
  deltaMillicents: number;
  variancePct: number;
}

// ---------------------------------------------------------------------------
// 5-minute rolling window aggregator
// ---------------------------------------------------------------------------

const WINDOW_MS = 5 * 60 * 1_000; // 5 minutes
const HEARTBEAT_MS = 20_000;

/**
 * Aggregate incoming FleetRealtimeEvents into 5-minute cost windows and
 * flush them as SSE messages.
 */
class CostWindowAggregator {
  private windowStart: number;
  private events: FleetRealtimeEvent[] = [];
  private readonly onFlush: (window: CostImpactWindow) => void;

  constructor(onFlush: (window: CostImpactWindow) => void) {
    this.windowStart = this.currentWindowStart();
    this.onFlush = onFlush;
  }

  /** Floor ts to the nearest 5-minute boundary. */
  private currentWindowStart(): number {
    const now = Date.now();
    return now - (now % WINDOW_MS);
  }

  /** Ingest a batch of events. Triggers a flush if the window has rolled. */
  ingest(incoming: FleetRealtimeEvent[]): void {
    const nowWindow = this.currentWindowStart();

    if (nowWindow > this.windowStart && this.events.length > 0) {
      // Window rolled — flush current bucket, start fresh.
      this.flush(this.windowStart, nowWindow);
      this.events = [];
      this.windowStart = nowWindow;
    }

    for (const ev of incoming) {
      // Only accumulate events that carry fleet event/outcome labels.
      if (ev.fleet_event) this.events.push(ev);
    }
  }

  /** Force-flush whatever has accumulated (called on demand or at heartbeat). */
  flushNow(): void {
    if (this.events.length === 0) return;
    const end = Date.now();
    this.flush(this.windowStart, end);
    this.events = [];
    this.windowStart = this.currentWindowStart();
  }

  private flush(startMs: number, endMs: number): void {
    const windowStart = new Date(startMs).toISOString();
    const windowEnd   = new Date(endMs).toISOString();

    // Group by (fleet_event, fleet_outcome).
    const bucketMap = new Map<string, CostImpactBucket>();

    let lastBaseline = 0;

    for (const ev of this.events) {
      const key = `${ev.fleet_event ?? "unknown"}:${ev.fleet_outcome ?? "unknown"}`;
      let bucket = bucketMap.get(key);
      if (!bucket) {
        bucket = {
          fleet_event:          ev.fleet_event  ?? "unknown",
          fleet_outcome:        ev.fleet_outcome ?? "unknown",
          event_count:          0,
          total_millicents:     0,
          avg_delta_millicents: 0,
          avg_variance_pct:     0,
        };
        bucketMap.set(key, bucket);
      }

      bucket.event_count++;
      bucket.total_millicents     += ev.cost_millicents ?? 0;
      bucket.avg_delta_millicents += ev.cost_delta_millicents ?? 0;
      bucket.avg_variance_pct     += ev.variance_pct ?? 0;

      if (ev.team_avg_millicents !== undefined) {
        lastBaseline = ev.team_avg_millicents;
      }
    }

    // Finalise averages.
    for (const bucket of bucketMap.values()) {
      if (bucket.event_count > 0) {
        bucket.avg_delta_millicents = Number((bucket.avg_delta_millicents / bucket.event_count).toFixed(2));
        bucket.avg_variance_pct     = Number((bucket.avg_variance_pct     / bucket.event_count).toFixed(2));
      }
    }

    const buckets = [...bucketMap.values()].sort(
      (a, b) => b.total_millicents - a.total_millicents,
    );

    const totalMillicents    = buckets.reduce((s, b) => s + b.total_millicents, 0);
    const eventCount         = buckets.reduce((s, b) => s + b.event_count, 0);
    const baselineTotal      = lastBaseline * eventCount;
    const deltaMillicents    = totalMillicents - baselineTotal;
    const variancePct        = baselineTotal > 0
      ? Number(Math.max(-9999, Math.min(9999, (deltaMillicents / baselineTotal) * 100)).toFixed(2))
      : (deltaMillicents > 0 ? 9999 : deltaMillicents < 0 ? -9999 : 0);

    this.onFlush({
      windowStart,
      windowEnd,
      buckets,
      totalMillicents,
      baselineMillicents: lastBaseline,
      deltaMillicents,
      variancePct,
    });
  }
}

// ---------------------------------------------------------------------------
// Peer-share scope check (mirrors /api/dashboard/subscribe)
// ---------------------------------------------------------------------------

async function resolveTarget(
  viewerId: string,
  asParam: string | null,
): Promise<string | null> {
  if (!asParam || asParam === viewerId) return viewerId;

  const grants = await listGrantsForViewer(viewerId);
  const active  = grants.filter((g) => g.owner_id === asParam);
  if (active.length === 0) return null;

  return asParam;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const asParam      = req.nextUrl.searchParams.get("as");
  const targetUserId = await resolveTarget(me.id, asParam);

  if (!targetUserId) {
    return NextResponse.json(
      { error: "no active peer-share grant from that user" },
      { status: 403 },
    );
  }

  log.info({
    msg:            "fleet/cost-impact/subscribe: SSE connection opened",
    viewer_id:      me.id,
    target_user_id: targetUserId,
    peer_view:      targetUserId !== me.id,
  });

  let unregister: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const enqueue = (window: CostImpactWindow) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(window)}\n\n`));
        } catch {
          // Stream closed — ignore.
        }
      };

      const aggregator = new CostWindowAggregator(enqueue);

      // Wrap the aggregator in an SseController so the shared registry can
      // deliver FleetRealtimeEvents to it via notifySSESubscribers().
      const ctrl: SseController = {
        send(events: FleetRealtimeEvent[]): boolean {
          try {
            aggregator.ingest(events);
            return true;
          } catch {
            return false;
          }
        },
        close() {
          try { controller.close(); } catch { /* already closed */ }
        },
      };

      unregister = register(targetUserId, ctrl);

      // Initial connected comment.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Heartbeat: flush any accumulated events every HEARTBEAT_MS so the
      // widget refreshes even during low-activity periods.
      heartbeatTimer = setInterval(() => {
        try {
          aggregator.flushNow();
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream closed.
        }
      }, HEARTBEAT_MS);
    },

    cancel() {
      if (heartbeatTimer != null) clearInterval(heartbeatTimer);
      if (unregister) unregister();

      log.info({
        msg:            "fleet/cost-impact/subscribe: SSE connection closed",
        viewer_id:      me.id,
        target_user_id: targetUserId,
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      Connection:        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
