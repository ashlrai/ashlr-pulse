/**
 * /api/peer-share-subscribe — webhook subscription management.
 *
 * POST   — register a webhook to receive pushed aggregate deltas.
 * DELETE — unregister a webhook subscription.
 * GET    — list the caller's active subscriptions (webhook_url omitted).
 *
 * Auth: cookie-session via currentUser(). The caller must hold an active
 * non-revoked peer_share grant from the owner before subscribing.
 *
 * Privacy floor:
 *   • Subscriptions are viewer-scoped. A viewer cannot register on behalf
 *     of another viewer.
 *   • The grant's field whitelist is enforced at push-time in the cron fanout.
 *   • webhook_url is stored and used for delivery but never echoed to other
 *     viewers — the GET response omits it.
 *
 * POST body (JSON):
 *   {
 *     owner_id:    string   — UUID of the data owner (must have an active grant)
 *     granularity: "hourly" | "weekly"
 *     webhook_url: string   — HTTPS URL to receive aggregate delta pushes
 *     scope_type:  "all" | "project" | "repo_pattern"   (default "all")
 *     scope_value: string | null   (required when scope_type != "all")
 *   }
 *
 * DELETE body (JSON):
 *   { id: string }              — by subscription UUID, OR
 *   { owner_id, granularity }   — by (owner, granularity) key
 *
 * Responses:
 *   201  — { subscriber: PeerShareSubscriberRow }   (POST success)
 *   200  — { ok: true }                             (DELETE success)
 *   200  — { subscriptions: [...] }                 (GET)
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

export const runtime = "nodejs";

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

// ---------------------------------------------------------------------------
// GET — list caller's subscriptions
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const subscriptions = await listSubscribersForViewer(me.id);
  return NextResponse.json({ subscriptions });
}

// ---------------------------------------------------------------------------
// POST — register webhook
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
// DELETE — unregister webhook
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
