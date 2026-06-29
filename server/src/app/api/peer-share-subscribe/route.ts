/**
 * /api/peer-share-subscribe — webhook subscription management + SSE push channel.
 *
 * GET    — open an SSE stream that receives push updates when peer-share
 *          aggregate tables (hourly/daily/weekly) are refreshed by the cron.
 * POST   — register a webhook to receive pushed aggregate deltas.
 * DELETE — unregister a webhook subscription.
 *
 * Auth: cookie-session via currentUser(). The caller must hold an active
 * non-revoked peer_share grant from the owner before subscribing.
 *
 * ─── GET — SSE channel ───────────────────────────────────────────────────────
 *
 * Query params:
 *   ?owner_id=<uuid>  — subscribe to updates from this owner. The caller must
 *                        hold an active peer-share grant from this owner.
 *                        Omit to subscribe to all granted owners' updates.
 *
 * Event format:
 *
 *   event: peer_share_agg
 *   data: { "type":"peer_share_agg", "ts":"...", "aggregate_type":"hourly",
 *            "owner_id":"...", "viewer_id":"...", "bucket_start":"...",
 *            "cost_millicents":..., "tokens_input":..., "tokens_output":...,
 *            "event_count":..., [optional breakdowns gated by grant fields] }
 *
 *   event: heartbeat
 *   data: { "ts":"..." }
 *
 * Backpressure:
 *   If the client falls more than LAG_THRESHOLD events behind, the controller
 *   is evicted. EventSource auto-reconnects (browser spec); lag clears on the
 *   new connection (new controller registration).
 *
 * Privacy floor:
 *   • Only SHAREABLE_FIELDS values appear in broadcast payloads (enforced by
 *     notifyPeerShareSubscribers → broadcastPeerShareAgg → PeerShareAggEvent).
 *   • Forbidden fields (prompts, completions, raw_otel_span) are structurally
 *     absent from the event type.
 *   • Scope filter: when ?owner_id= is supplied, the controller only forwards
 *     events whose owner_id matches — cross-owner leakage is impossible.
 *
 * ─── POST body (JSON) ────────────────────────────────────────────────────────
 *   {
 *     owner_id:    string   — UUID of the data owner (must have an active grant)
 *     granularity: "hourly" | "weekly"
 *     webhook_url: string   — HTTPS URL to receive aggregate delta pushes
 *     scope_type:  "all" | "project" | "repo_pattern"   (default "all")
 *     scope_value: string | null   (required when scope_type != "all")
 *   }
 *
 * ─── DELETE body (JSON) ──────────────────────────────────────────────────────
 *   { id: string }              — by subscription UUID, OR
 *   { owner_id, granularity }   — by (owner, granularity) key
 *
 * Responses:
 *   200  — text/event-stream    (GET — SSE stream)
 *   201  — { subscriber: PeerShareSubscriberRow }   (POST success)
 *   200  — { ok: true }                             (DELETE success)
 *   400  — { error: string }                        (validation failure)
 *   401  — { error: "unauthorized" }
 *   403  — { error: "no active peer-share grant from that owner" }
 *   404  — { error: "subscription not found" }      (DELETE miss)
 *   409  — { error: "already subscribed" }          (race condition, rare)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import {
  upsertSubscriber,
  deleteSubscriber,
  deleteSubscriberByKey,
  listSubscribersForViewer,
} from "@/lib/peer-share-subscribe-db";
import {
  registerPeerShareController,
  makePeerShareAggController,
  type PeerShareAggEvent,
} from "@/lib/dashboard-sse-broadcast";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 20_000; // 20 s — keeps proxies from closing idle connections

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PostSchema = z.object({
  owner_id: z.string().uuid("owner_id must be a valid UUID"),
  granularity: z.enum(["hourly", "weekly"]),
  webhook_url: z
    .string()
    .url("webhook_url must be a valid URL")
    .refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", {
      message: "webhook_url must use HTTPS in production",
    }),
  scope_type: z.enum(["all", "project", "repo_pattern"]).default("all"),
  scope_value: z.string().nullable().optional(),
});

const DeleteSchema = z.union([
  z.object({ id: z.string().uuid("id must be a valid UUID") }),
  z.object({
    owner_id: z.string().uuid("owner_id must be a valid UUID"),
    granularity: z.enum(["hourly", "weekly"]),
  }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hasGrantFrom(viewerId: string, ownerId: string): Promise<boolean> {
  const grants = await listGrantsForViewer(viewerId);
  return grants.some((g) => g.owner_id === ownerId);
}

/** Fetch all active grant owner_ids for a viewer. */
async function grantedOwnerIds(viewerId: string): Promise<string[]> {
  const grants = await listGrantsForViewer(viewerId);
  return grants.map((g) => g.owner_id);
}

// ---------------------------------------------------------------------------
// GET — SSE channel for real-time peer-share aggregate push
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  let me;
  try {
    me = await currentUser();
  } catch (err) {
    log.warn({ msg: "peer-share-subscribe-sse: currentUser threw", error: String(err) });
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }

  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── 2. Resolve scope filter (optional ?owner_id= param) ──────────────────
  const ownerIdParam = req.nextUrl.searchParams.get("owner_id");

  // When ?owner_id= is supplied, verify the caller holds an active grant.
  if (ownerIdParam) {
    let allowed: boolean;
    try {
      allowed = await hasGrantFrom(me.id, ownerIdParam);
    } catch (err) {
      log.warn({ msg: "peer-share-subscribe-sse: grant check threw", error: String(err) });
      return NextResponse.json({ error: "internal server error" }, { status: 500 });
    }
    if (!allowed) {
      return NextResponse.json(
        { error: "no active peer-share grant from that owner" },
        { status: 403 },
      );
    }
  }

  // Collect the set of ownerIds this viewer is allowed to see.
  // Used at broadcast time to filter events (scope guard).
  let allowedOwnerIds: Set<string>;
  try {
    if (ownerIdParam) {
      allowedOwnerIds = new Set([ownerIdParam]);
    } else {
      const ids = await grantedOwnerIds(me.id);
      if (ids.length === 0) {
        return NextResponse.json(
          { error: "no active peer-share grants — nothing to subscribe to" },
          { status: 403 },
        );
      }
      allowedOwnerIds = new Set(ids);
    }
  } catch (err) {
    log.warn({ msg: "peer-share-subscribe-sse: grant list threw", error: String(err) });
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }

  log.info({
    msg: "peer-share-subscribe-sse: connection opened",
    viewer_id: me.id,
    owner_id_filter: ownerIdParam ?? "all",
    allowed_owners: allowedOwnerIds.size,
  });

  // ── 3. Build SSE stream ───────────────────────────────────────────────────
  let unregister: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Capture the viewer_id and allowedOwnerIds in closure for the cancel callback.
  const viewerId = me.id;
  const scopedAllowedOwners = allowedOwnerIds;

  const stream = new ReadableStream<Uint8Array>({
    start(underlyingCtrl) {
      const encoder = new TextEncoder();
      const connId = `ps-conn-${viewerId}-${Date.now()}`;

      // Wrap the underlying controller with scope filtering.
      // Only events whose owner_id is in the allowed set are forwarded.
      const baseCtrl = makePeerShareAggController(underlyingCtrl, encoder, connId);

      // Proxy that applies the per-subscriber scope filter on send().
      const scopedCtrl = {
        ...baseCtrl,
        send(event: PeerShareAggEvent): boolean {
          // Scope guard: drop events from owners outside this subscription's scope.
          if (!scopedAllowedOwners.has(event.owner_id)) return true; // silently drop, not an error
          return baseCtrl.send(event);
        },
      };

      // Register with the peer-share broadcast layer.
      unregister = registerPeerShareController(viewerId, scopedCtrl);

      // Initial connected comment (triggers browser EventSource onopen).
      try {
        underlyingCtrl.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        // Already cancelled before start completed.
      }

      // Heartbeat keeps the connection alive through proxies.
      heartbeatTimer = setInterval(() => {
        const ts = new Date().toISOString();
        // Reset lag on heartbeat — client is alive.
        baseCtrl.resetLag();
        scopedCtrl.sendHeartbeat(ts);
      }, HEARTBEAT_MS);
    },

    cancel() {
      if (heartbeatTimer != null) clearInterval(heartbeatTimer);
      if (unregister) unregister();

      log.info({
        msg: "peer-share-subscribe-sse: connection closed",
        viewer_id: viewerId,
        owner_id_filter: ownerIdParam ?? "all",
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

// ---------------------------------------------------------------------------
// POST — register webhook subscription
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = PostSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // A viewer cannot subscribe to their own data via this push path.
  if (body.owner_id === me.id) {
    return NextResponse.json(
      { error: "cannot subscribe to your own data" },
      { status: 400 },
    );
  }

  // Enforce scope_value requirement.
  const scopeValue = body.scope_value ?? null;
  if (body.scope_type !== "all" && !scopeValue) {
    return NextResponse.json(
      { error: "scope_value is required when scope_type is not 'all'" },
      { status: 400 },
    );
  }

  // Must hold an active grant from this owner.
  const allowed = await hasGrantFrom(me.id, body.owner_id);
  if (!allowed) {
    return NextResponse.json(
      { error: "no active peer-share grant from that owner" },
      { status: 403 },
    );
  }

  try {
    const subscriber = await upsertSubscriber({
      viewer_id: me.id,
      owner_id: body.owner_id,
      scope_type: body.scope_type,
      scope_value: body.scope_type === "all" ? null : scopeValue,
      granularity: body.granularity,
      webhook_url: body.webhook_url,
    });

    return NextResponse.json({ subscriber }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique/i.test(message)) {
      return NextResponse.json({ error: "already subscribed" }, { status: 409 });
    }
    return NextResponse.json({ error: "subscribe failed", detail: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — unregister webhook subscription
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = DeleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const body = parsed.data;

  let removed: boolean;

  if ("id" in body) {
    removed = await deleteSubscriber(body.id, me.id);
  } else {
    removed = await deleteSubscriberByKey(me.id, body.owner_id, body.granularity);
  }

  if (!removed) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
