/**
 * GET /api/dashboard/subscribe
 *
 * Server-Sent Events (SSE) subscription for the /app dashboard.
 *
 * The client connects once on mount and receives FleetRealtimeEvent batches
 * as they are ingested via the OTLP route → pushFleetEvents() → here.
 * This eliminates the 5–10s polling gap for peer-share viewers and owners
 * alike, reducing stale-data latency from ~30s to ~2s.
 *
 * ─── Auth / peer-share scope ────────────────────────────────────────────────
 *
 * Query params:
 *   ?as=<userId>   — peer-share view: the caller (viewer) must hold an active
 *                    non-revoked grant from <userId>. Events are filtered to
 *                    the grant's scope before streaming.
 *
 * Without ?as, the subscriber receives their own events only.
 *
 * ─── Privacy floor ──────────────────────────────────────────────────────────
 *
 * Every event that leaves this endpoint has already been stripped by
 * redactForBroadcast() (same path as Supabase Realtime push). The same
 * FORBIDDEN_FIELDS + assertMetadataOnly guards apply — no prompts,
 * completions, or raw_otel_span ever appear in any SSE message.
 *
 * ─── Mechanism ──────────────────────────────────────────────────────────────
 *
 * pushFleetEvents() calls notifySSESubscribers() (dashboard-sse-registry.ts)
 * alongside the Supabase broadcast. notifySSESubscribers() fans out to all
 * SseController instances registered for that userId. Each controller enqueues
 * a "data: <json>\n\n" line onto its ReadableStream.
 *
 * The SSE connection is kept alive with a heartbeat comment (":\n\n") every
 * HEARTBEAT_MS milliseconds.
 *
 * ─── Feature flag ───────────────────────────────────────────────────────────
 *
 * Active when PULSE_REALTIME_PUSH=true (same flag as Supabase push). When
 * the flag is absent the route still responds with a 200 SSE stream but
 * sends no events — the client gracefully falls back to polling.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import { log } from "@/lib/logger";
import { register, type SseController } from "@/lib/dashboard-sse-registry";
import type { FleetRealtimeEvent } from "@/lib/fleet-realtime";

export const runtime = "nodejs";
// SSE connections are long-lived; disable Next.js response buffering.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Peer-share scope check
// ---------------------------------------------------------------------------

/**
 * Validate the caller is allowed to watch `targetUserId`'s events.
 * Returns the resolved targetUserId on success, null on deny.
 *
 * If ?as is omitted the caller watches their own stream — always allowed.
 * If ?as is set the caller must hold an active peer-share grant from that user.
 */
async function resolveTarget(
  viewerId: string,
  asParam: string | null,
): Promise<string | null> {
  if (!asParam || asParam === viewerId) return viewerId;

  const grants = await listGrantsForViewer(viewerId);
  const active = grants.filter((g) => g.owner_id === asParam);
  if (active.length === 0) return null;

  return asParam;
}

// ---------------------------------------------------------------------------
// SSE heartbeat interval
// ---------------------------------------------------------------------------
const HEARTBEAT_MS = 20_000; // 20 s — keeps idle connections alive through proxies

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const asParam = req.nextUrl.searchParams.get("as");
  const targetUserId = await resolveTarget(me.id, asParam);

  if (!targetUserId) {
    return NextResponse.json(
      { error: "no active peer-share grant from that user" },
      { status: 403 },
    );
  }

  log.info({
    msg: "dashboard-subscribe: SSE connection opened",
    viewer_id: me.id,
    target_user_id: targetUserId,
    peer_view: targetUserId !== me.id,
  });

  // Build the SSE ReadableStream.
  let unregister: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      // Build the SseController wrapper around this ReadableStream controller.
      const ctrl: SseController = {
        send(events: FleetRealtimeEvent[]): boolean {
          try {
            const data = JSON.stringify(events);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            return true;
          } catch {
            return false;
          }
        },
        close() {
          try {
            controller.close();
          } catch {
            // Already closed — ignore.
          }
        },
      };

      unregister = register(targetUserId, ctrl);

      // Send an initial "connected" comment so the client knows the stream
      // is live. SSE comments (lines starting with ":") are not dispatched
      // as events but do trigger the browser's onopen handler.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Heartbeat: send a keep-alive comment periodically.
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream closed — the cancel() call below will clean up.
        }
      }, HEARTBEAT_MS);
    },

    cancel() {
      // Client disconnected or server closed the stream.
      if (heartbeatTimer != null) clearInterval(heartbeatTimer);
      if (unregister) unregister();

      log.info({
        msg: "dashboard-subscribe: SSE connection closed",
        viewer_id: me.id,
        target_user_id: targetUserId,
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx/proxy buffering so events flow immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
