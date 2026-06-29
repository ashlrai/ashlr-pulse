/**
 * peer-share-subscribe-db.ts — DB access for the peer_share_subscriber table.
 *
 * Tracks webhook subscriptions registered by viewers who want push delivery
 * of materialized aggregate deltas instead of polling.
 *
 * Privacy invariants:
 *   • A subscription is always viewer-scoped: a viewer can only register
 *     webhooks for data they are already granted access to (caller must
 *     validate the active peer_share grant before inserting a subscriber row).
 *   • webhook_url is stored but NEVER echoed in query results beyond the
 *     owning viewer's own GET — no cross-viewer URL leakage.
 *   • Payload fanout (broadcastPeerShareAggregate) enforces SHAREABLE_FIELDS
 *     independently at send time.
 *
 * Schema (DDL not managed here — applied via migration):
 *
 *   CREATE TABLE peer_share_subscriber (
 *     id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     viewer_id     UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 *     owner_id      UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 *     scope_type    TEXT        NOT NULL DEFAULT 'all'
 *                               CHECK (scope_type IN ('all','project','repo_pattern')),
 *     scope_value   TEXT,
 *     granularity   TEXT        NOT NULL DEFAULT 'hourly'
 *                               CHECK (granularity IN ('hourly','weekly')),
 *     webhook_url   TEXT        NOT NULL,
 *     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     last_push_at  TIMESTAMPTZ,
 *     -- Exponential-backoff state
 *     fail_count    INT         NOT NULL DEFAULT 0,
 *     next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     CONSTRAINT peer_share_subscriber_unique
 *       UNIQUE (viewer_id, owner_id, scope_type, COALESCE(scope_value,''), granularity)
 *   );
 */

import { sql } from "./db";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface PeerShareSubscriberRow {
  id: string;
  viewer_id: string;
  owner_id: string;
  scope_type: "all" | "project" | "repo_pattern";
  scope_value: string | null;
  granularity: "hourly" | "weekly";
  webhook_url: string;
  created_at: string;
  last_push_at: string | null;
  fail_count: number;
  next_retry_at: string;
}

export interface CreateSubscriberInput {
  viewer_id: string;
  owner_id: string;
  scope_type: "all" | "project" | "repo_pattern";
  scope_value: string | null;
  granularity: "hourly" | "weekly";
  webhook_url: string;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Insert or update a subscriber row. Uses ON CONFLICT UPDATE so re-registering
 * with a new webhook_url replaces the old one and resets backoff state.
 */
export async function upsertSubscriber(
  input: CreateSubscriberInput,
): Promise<PeerShareSubscriberRow> {
  const db = sql();
  const scopeValue = input.scope_value ?? null;

  const [row] = await db<PeerShareSubscriberRow[]>`
    INSERT INTO peer_share_subscriber
      (viewer_id, owner_id, scope_type, scope_value, granularity, webhook_url,
       fail_count, next_retry_at)
    VALUES (
      ${input.viewer_id}::uuid,
      ${input.owner_id}::uuid,
      ${input.scope_type},
      ${scopeValue},
      ${input.granularity},
      ${input.webhook_url},
      0,
      NOW()
    )
    ON CONFLICT ON CONSTRAINT peer_share_subscriber_unique DO UPDATE SET
      webhook_url   = EXCLUDED.webhook_url,
      fail_count    = 0,
      next_retry_at = NOW(),
      last_push_at  = peer_share_subscriber.last_push_at
    RETURNING
      id::text         AS id,
      viewer_id::text  AS viewer_id,
      owner_id::text   AS owner_id,
      scope_type,
      scope_value,
      granularity,
      webhook_url,
      created_at,
      last_push_at,
      fail_count,
      next_retry_at
  `;
  return row;
}

/**
 * Delete a subscriber row. Returns true if a row was removed.
 * Only the owning viewer can delete their own subscription.
 */
export async function deleteSubscriber(
  id: string,
  viewerId: string,
): Promise<boolean> {
  const db = sql();
  const result = await db`
    DELETE FROM peer_share_subscriber
    WHERE id = ${id}::uuid AND viewer_id = ${viewerId}::uuid
  `;
  return result.count === 1;
}

/**
 * Delete a subscriber row by (viewer_id, owner_id, granularity) triple.
 * Used by DELETE /api/peer-share-subscribe when the client identifies by
 * owner/granularity rather than by subscription ID.
 */
export async function deleteSubscriberByKey(
  viewerId: string,
  ownerId: string,
  granularity: "hourly" | "weekly",
): Promise<boolean> {
  const db = sql();
  const result = await db`
    DELETE FROM peer_share_subscriber
    WHERE viewer_id   = ${viewerId}::uuid
      AND owner_id    = ${ownerId}::uuid
      AND granularity = ${granularity}
  `;
  return result.count >= 1;
}

/** List all subscriptions owned by a viewer (for GET). */
export async function listSubscribersForViewer(
  viewerId: string,
): Promise<Omit<PeerShareSubscriberRow, "webhook_url">[]> {
  const db = sql();
  // Intentionally omit webhook_url from the list response — the URL is
  // sensitive and not needed for display purposes.
  return db<Omit<PeerShareSubscriberRow, "webhook_url">[]>`
    SELECT
      id::text         AS id,
      viewer_id::text  AS viewer_id,
      owner_id::text   AS owner_id,
      scope_type,
      scope_value,
      granularity,
      created_at,
      last_push_at,
      fail_count,
      next_retry_at
    FROM peer_share_subscriber
    WHERE viewer_id = ${viewerId}::uuid
    ORDER BY created_at DESC
  `;
}

/**
 * Fetch all subscriptions that are due for delivery (next_retry_at <= NOW()).
 * Includes webhook_url for the cron fanout.
 * Used by the cron fanout; intentionally internal (not exported to API layer).
 */
export async function listDueSubscribers(): Promise<PeerShareSubscriberRow[]> {
  const db = sql();
  return db<PeerShareSubscriberRow[]>`
    SELECT
      id::text         AS id,
      viewer_id::text  AS viewer_id,
      owner_id::text   AS owner_id,
      scope_type,
      scope_value,
      granularity,
      webhook_url,
      created_at,
      last_push_at,
      fail_count,
      next_retry_at
    FROM peer_share_subscriber
    WHERE next_retry_at <= NOW()
    ORDER BY next_retry_at ASC
  `;
}

/**
 * Mark a subscription delivery as successful.
 * Resets fail_count and advances next_retry_at to the next natural schedule.
 *
 * @param id          Subscription UUID.
 * @param granularity "hourly" schedules next push in 1 h; "weekly" in 7 days.
 */
export async function markSubscriberDelivered(
  id: string,
  granularity: "hourly" | "weekly",
): Promise<void> {
  const db = sql();
  const intervalSql =
    granularity === "weekly" ? "INTERVAL '7 days'" : "INTERVAL '1 hour'";
  await db`
    UPDATE peer_share_subscriber
    SET
      last_push_at  = NOW(),
      fail_count    = 0,
      next_retry_at = NOW() + ${db.unsafe(intervalSql)}
    WHERE id = ${id}::uuid
  `;
}

/**
 * Mark a delivery failure and compute exponential backoff for next_retry_at.
 *
 * Back-off schedule (capped at 4 h):
 *   fail_count 1 → 2 min
 *   fail_count 2 → 4 min
 *   fail_count 3 → 8 min
 *   fail_count 4 → 16 min
 *   … capped at 240 min (4 h)
 */
export async function markSubscriberFailed(id: string): Promise<void> {
  const db = sql();
  // Compute next_retry_at in the DB to avoid clock-skew between app nodes.
  // fail_count is incremented first, then used for backoff exponent.
  await db`
    UPDATE peer_share_subscriber
    SET
      fail_count    = fail_count + 1,
      next_retry_at = NOW() + (
        LEAST(240, 2 * POWER(2, fail_count)::int) * INTERVAL '1 minute'
      )
    WHERE id = ${id}::uuid
  `;
}
