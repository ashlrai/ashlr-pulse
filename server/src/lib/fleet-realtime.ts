/**
 * fleet-realtime.ts — privacy-floor-safe push for fleet events.
 *
 * After the OTLP ingest route inserts ashlr-fleet rows, it calls
 * pushFleetEvents() so subscribed dashboard clients receive updates
 * push-style instead of polling.
 *
 * Mechanism: Supabase Realtime broadcast on a per-user channel
 *   `fleet-events:{userId}`
 * The admin client is used so the push happens server-side without
 * a user session. Each broadcast message carries a single fleet
 * event payload stripped to the SHAREABLE_FIELDS whitelist.
 *
 * Privacy floor
 * ─────────────
 * The same two guards that protect the peer-share path apply here:
 *
 *   1. FORBIDDEN_FIELDS (peer-share-guard.ts) — any key in that set is
 *      dropped from the broadcast payload before it leaves the server.
 *      This covers prompts, completions, raw_otel_span.
 *
 *   2. assertMetadataOnly (peer-share-guard.ts) — applied to any
 *      free-form `meta` / `properties` bags. Throws MetadataFloorError
 *      if a forbidden key or over-long string sneaks in; the throw is
 *      caught and the event is silently dropped (never broadcast).
 *
 * Feature flag
 * ────────────
 * Push is disabled unless PULSE_REALTIME_PUSH=true. This keeps the
 * hot ingest path unchanged in production until the feature is
 * explicitly enabled, and lets tests opt-out of network calls.
 *
 * Polling fallback
 * ────────────────
 * Dashboard clients always retain their existing polling path.
 * The realtime push is purely additive — a missed or dropped broadcast
 * just means the next poll catches up.
 */

import { FORBIDDEN_FIELDS, assertMetadataOnly, MetadataFloorError } from "./peer-share-guard";
import { admin } from "./supabase-server";
import { log } from "./logger";
import type { ActivityEventInsert } from "./otel-genai";

// Lazy import of notifySSESubscribers — the registry module is a plain lib
// file with no Next.js route constraints. Lazy to guard test envs that stub it.
async function notifySSE(userId: string, events: FleetRealtimeEvent[]): Promise<void> {
  try {
    const { notifySSESubscribers } = await import("./dashboard-sse-registry");
    notifySSESubscribers(userId, events);
  } catch {
    // Registry unavailable (test stub / cold env) — ignore, never block ingest.
  }
}

// ---------------------------------------------------------------------------
// Fleet event shape for broadcast (privacy-safe subset of ActivityEventInsert)
// ---------------------------------------------------------------------------

/**
 * The subset of ActivityEventInsert fields that may be broadcast over
 * Supabase Realtime. Mirrors SHAREABLE_FIELDS but restricted to the
 * fleet-relevant columns so the payload stays small.
 */
export interface FleetRealtimeEvent {
  ts: string;
  source: string;
  fleet_event: string | null;
  fleet_outcome: string | null;
  fleet_owner: string | null;
  repo_name: string | null;
  provider: string | null;
  model: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_millicents: number | null;
}

/**
 * NEVER_BROADCAST — superset of FORBIDDEN_FIELDS for the realtime path.
 * These keys must not appear in any broadcast payload regardless of which
 * ActivityEventInsert field they come from.
 */
const NEVER_BROADCAST = new Set<string>([
  ...FORBIDDEN_FIELDS,
  // Additional fields with content risk on the realtime path:
  "session_id",
  "project_hash",
  "git_branch",
  "language",
  "tokens_saved_breakdown",
  "plugin_features",
  "span_id",
  "dedup_key",
  "pricing_version",
]);

// ---------------------------------------------------------------------------
// redactForBroadcast
// ---------------------------------------------------------------------------

/**
 * Strip any key in NEVER_BROADCAST from an arbitrary object and run
 * assertMetadataOnly on any nested object/array values. Returns a
 * plain-object copy safe for broadcast, or throws MetadataFloorError if
 * the meta floor is violated.
 *
 * Exported for testing.
 */
export function redactForBroadcast(row: ActivityEventInsert): FleetRealtimeEvent {
  const safe: FleetRealtimeEvent = {
    ts:            row.ts,
    source:        row.source,
    fleet_event:   row.fleet_event,
    fleet_outcome: row.fleet_outcome,
    fleet_owner:   row.fleet_owner,
    repo_name:     row.repo_name,
    provider:      row.provider,
    model:         row.model,
    duration_ms:   row.duration_ms,
    tokens_input:  row.tokens_input,
    tokens_output: row.tokens_output,
    cost_millicents: row.cost_millicents,
  };

  // Verify no NEVER_BROADCAST key leaked into the constructed object.
  // This is a belt-and-suspenders check — the explicit field selection above
  // already excludes them, but we keep this so a future field addition to
  // FleetRealtimeEvent doesn't silently bypass the guard.
  for (const key of Object.keys(safe) as (keyof FleetRealtimeEvent)[]) {
    if (NEVER_BROADCAST.has(key as string)) {
      delete (safe as unknown as Record<string, unknown>)[key as string];
    }
  }

  // Run the metadata floor on any object/array values (safe but paranoid).
  assertMetadataOnly(safe, "fleet_broadcast");

  return safe;
}

// ---------------------------------------------------------------------------
// pushFleetEvents — main entry point
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget broadcast of fleet events to subscribed dashboard clients.
 *
 * Only runs when PULSE_REALTIME_PUSH=true. Silently no-ops otherwise so the
 * ingest path never blocks on a disabled feature.
 *
 * @param userId  - owner of the events; channel is `fleet-events:{userId}`
 * @param rows    - all activity rows from this OTLP batch; non-fleet rows
 *                  are filtered out before broadcast.
 */
export async function pushFleetEvents(
  userId: string,
  rows: ActivityEventInsert[],
): Promise<void> {
  if (process.env.PULSE_REALTIME_PUSH !== "true") return;

  const fleetRows = rows.filter((r) => r.source === "ashlr-fleet" && r.fleet_event);
  if (fleetRows.length === 0) return;

  const channel = `fleet-events:${userId}`;

  // Collect privacy-safe payloads for SSE fan-out after the Supabase loop.
  const ssePayloads: FleetRealtimeEvent[] = [];

  for (const row of fleetRows) {
    let payload: FleetRealtimeEvent;
    try {
      payload = redactForBroadcast(row);
    } catch (err) {
      if (err instanceof MetadataFloorError) {
        log.warn({
          msg: "fleet-realtime: privacy floor violation — dropping event",
          fleet_event: row.fleet_event,
          user_id: userId,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }

    // 1. Supabase Realtime broadcast (existing path).
    try {
      const sb = admin();
      // Supabase Realtime broadcast: server-side push via the admin client.
      // Uses the REST broadcast endpoint (no persistent WS connection needed
      // server-side — the client subscribes and the server just pushes).
      const status = await sb
        .channel(channel)
        .send({
          type: "broadcast",
          event: "fleet_event",
          payload,
        });

      if (status !== "ok") {
        log.warn({
          msg: "fleet-realtime: broadcast error",
          channel,
          fleet_event: row.fleet_event,
          error: String(status),
        });
      }
    } catch (err) {
      // Never fail the ingest path due to a push error.
      log.warn({
        msg: "fleet-realtime: push threw",
        channel,
        fleet_event: row.fleet_event,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Accumulate for SSE fan-out (same redacted payload — no re-redaction needed).
    ssePayloads.push(payload);
  }

  // 2. SSE fan-out: push all valid payloads to any open /api/dashboard/subscribe
  //    connections in one batch. Fire-and-forget — never blocks ingest.
  if (ssePayloads.length > 0) {
    void notifySSE(userId, ssePayloads);
  }
}
