/**
 * GET /api/app/live
 *
 * Server-Sent Events (SSE) activity feed for the authenticated dashboard.
 *
 * Broadcasts live activity events (type: "activity") and anomaly alerts
 * (type: "anomaly") to connected dashboard users. Events are scoped to the
 * caller's org and filtered to SHAREABLE_FIELDS only — no prompts, code, or
 * raw spans ever leave this endpoint.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 *
 * Requires a valid Supabase session cookie (or PULSE_DEV_USER in dev). Returns
 * 401 when unauthenticated.
 *
 * ─── Peer-share scope ────────────────────────────────────────────────────────
 *
 * Query param:
 *   ?as=<userId>  — subscribe to that user's org feed. The caller must hold
 *                   an active non-revoked peer-share grant from <userId>.
 *                   Without ?as, the caller subscribes to their own org.
 *
 * ─── Rate limiting ───────────────────────────────────────────────────────────
 *
 * Max PULSE_LIVE_SSE_RATE connections per userId per minute (default: 10).
 * Each new connection consumes one token from the user's bucket. Exceeding
 * the limit returns 429 with Retry-After.
 *
 * ─── CORS ────────────────────────────────────────────────────────────────────
 *
 * Allows requests from PULSE_ALLOWED_ORIGINS (comma-separated). Defaults to
 * same-origin only. Preflight OPTIONS handled inline.
 *
 * ─── Backpressure ────────────────────────────────────────────────────────────
 *
 * Each controller tracks an internal lag counter. When a client falls more
 * than LAG_THRESHOLD events behind, the controller is marked as lagging and
 * evicted from the broadcast set. The client's EventSource auto-reconnects
 * (browser spec), at which point lag is cleared and the stream resumes fresh.
 *
 * ─── Privacy floor ───────────────────────────────────────────────────────────
 *
 * All events originate from redactForBroadcast() (fleet-realtime.ts) which
 * enforces NEVER_BROADCAST + assertMetadataOnly. This route does not
 * re-redact — it trusts the upstream layer but adds its own field allowlist
 * via toActivityEvent() in dashboard-sse-broadcast.ts.
 *
 * ─── Event format ────────────────────────────────────────────────────────────
 *
 * Each SSE message has a named event type and JSON payload:
 *
 *   event: activity
 *   data: { "event_id":"...", "ts":"...", "source":"...", ... }
 *
 *   event: anomaly
 *   data: { "event_id":"...", "ts":"...", "anomaly":{...} }
 *
 *   event: heartbeat
 *   data: { "ts":"..." }
 *
 * Heartbeats are sent every HEARTBEAT_MS to keep proxies from closing the
 * idle connection.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import { checkBucket } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import {
  registerOrgController,
  type OrgBroadcastController,
  type LiveEvent,
} from "@/lib/dashboard-sse-broadcast";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 20_000; // 20 s

// SSE connections per userId per minute (token-bucket capacity).
const SSE_RATE_CAPACITY = parseInt(process.env.PULSE_LIVE_SSE_RATE ?? "10", 10);
const SSE_RATE_REFILL = SSE_RATE_CAPACITY / 60; // refill per second

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function getAllowedOrigins(): Set<string> {
  const raw = process.env.PULSE_ALLOWED_ORIGINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = getAllowedOrigins();
  const effectiveOrigin =
    origin && allowed.has(origin) ? origin : null;

  const headers: HeadersInit = {
    Vary: "Origin",
  };
  if (effectiveOrigin) {
    (headers as Record<string, string>)["Access-Control-Allow-Origin"] = effectiveOrigin;
    (headers as Record<string, string>)["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Org resolution — get the org_id for a user
// ---------------------------------------------------------------------------

async function resolveOrgId(userId: string): Promise<string | null> {
  const db = sql();
  const [row] = await db<{ org_id: string }[]>`
    SELECT org_id::text AS org_id
    FROM membership
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  return row?.org_id ?? null;
}

// ---------------------------------------------------------------------------
// Peer-share scope resolution
// ---------------------------------------------------------------------------

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
// InProcessOrgController — ReadableStream-backed controller
// ---------------------------------------------------------------------------

let _connCounter = 0;

function makeOrgController(
  underlyingController: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): OrgBroadcastController {
  const connectionId = `conn-${++_connCounter}`;
  let closed = false;
  let lagCount = 0;

  return {
    connectionId,

    get isClosed() {
      return closed;
    },

    get isLagging() {
      return lagCount > LAG_THRESHOLD;
    },

    resetLag() {
      lagCount = 0;
    },

    send(event: LiveEvent): boolean {
      if (closed) return false;
      if (lagCount > LAG_THRESHOLD) return false;

      try {
        const line = formatSSEEvent(event);
        underlyingController.enqueue(encoder.encode(line));
        lagCount++;
        return true;
      } catch {
        closed = true;
        return false;
      }
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        underlyingController.close();
      } catch {
        // already closed
      }
    },
  };
}

// Expose for the controller factory (module-level constant after makeOrgController).
const LAG_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------

function formatSSEEvent(event: LiveEvent): string {
  if (event.type === "heartbeat") {
    return `event: heartbeat\ndata: ${JSON.stringify({ ts: event.ts })}\n\n`;
  }
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

// ---------------------------------------------------------------------------
// OPTIONS — CORS preflight
// ---------------------------------------------------------------------------

export async function OPTIONS(req: NextRequest): Promise<Response> {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ---------------------------------------------------------------------------
// GET — main SSE handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const origin = req.headers.get("origin");

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  let me;
  try {
    me = await currentUser();
  } catch (err) {
    log.warn({ msg: "live-sse: currentUser threw", error: String(err) });
    return NextResponse.json(
      { error: "internal server error" },
      { status: 500, headers: corsHeaders(origin) },
    );
  }

  if (!me) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: corsHeaders(origin) },
    );
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rl = checkBucket(`live-sse:${me.id}`, SSE_RATE_CAPACITY, SSE_RATE_REFILL);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too many connections — reconnect after backoff" },
      {
        status: 429,
        headers: {
          ...corsHeaders(origin),
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  // ── 3. Peer-share scope ───────────────────────────────────────────────────
  const asParam = req.nextUrl.searchParams.get("as");
  let targetUserId: string | null;
  try {
    targetUserId = await resolveTarget(me.id, asParam);
  } catch (err) {
    log.warn({ msg: "live-sse: resolveTarget threw", error: String(err) });
    return NextResponse.json(
      { error: "internal server error" },
      { status: 500, headers: corsHeaders(origin) },
    );
  }

  if (!targetUserId) {
    return NextResponse.json(
      { error: "no active peer-share grant from that user" },
      { status: 403, headers: corsHeaders(origin) },
    );
  }

  // ── 4. Resolve org ────────────────────────────────────────────────────────
  let orgId: string | null;
  try {
    orgId = await resolveOrgId(targetUserId);
  } catch (err) {
    log.warn({ msg: "live-sse: resolveOrgId threw", error: String(err) });
    return NextResponse.json(
      { error: "internal server error" },
      { status: 500, headers: corsHeaders(origin) },
    );
  }

  if (!orgId) {
    return NextResponse.json(
      { error: "user has no org — complete onboarding first" },
      { status: 403, headers: corsHeaders(origin) },
    );
  }

  log.info({
    msg: "live-sse: connection opened",
    viewer_id: me.id,
    target_user_id: targetUserId,
    org_id: orgId,
    peer_view: targetUserId !== me.id,
  });

  // ── 5. Build SSE stream ───────────────────────────────────────────────────
  let unregister: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let ctrl: OrgBroadcastController | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(underlyingCtrl) {
      const encoder = new TextEncoder();
      ctrl = makeOrgController(underlyingCtrl, encoder);

      // Register with the org broadcast layer.
      unregister = registerOrgController(orgId!, ctrl);

      // Initial connected comment (triggers browser onopen).
      try {
        underlyingCtrl.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        // Already cancelled.
      }

      // Heartbeat.
      heartbeatTimer = setInterval(() => {
        if (!ctrl) return;
        // Reset lag counter on each heartbeat — the client is alive.
        ctrl.resetLag();
        ctrl.send({ type: "heartbeat", ts: new Date().toISOString() });
      }, HEARTBEAT_MS);
    },

    cancel() {
      if (heartbeatTimer != null) clearInterval(heartbeatTimer);
      if (unregister) unregister();
      ctrl?.close();

      log.info({
        msg: "live-sse: connection closed",
        viewer_id: me!.id,
        target_user_id: targetUserId,
        org_id: orgId,
      });
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
