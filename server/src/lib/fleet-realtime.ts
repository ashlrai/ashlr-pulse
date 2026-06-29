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
import { computeCostImpactFields, type CostImpactFields } from "./fleet-cost-impact";

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
 *
 * Cost-impact fields (M49 fleet control plane) are appended on ingest
 * when a team-average baseline is available. They are pure numeric —
 * never contain user content.
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
  // Cost-impact fields — optional, set during pushFleetEvents when
  // a team_avg_millicents baseline is provided by the caller.
  user_cost_millicents?: number;
  team_avg_millicents?: number;
  peer_divergence_ratio?: number;
  peer_divergence_severity?: "low" | "medium" | "high";
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
// toFleetEventJSON — type-safe discriminated-union narrowing helper
// ---------------------------------------------------------------------------

/**
 * Convert a `FleetRealtimeEvent` to a plain `Record<string, any>` for
 * property-access patterns that need an index signature (e.g. test assertions
 * that check for the *absence* of fields by key name).
 *
 * **Why this helper exists**
 *
 * `FleetRealtimeEvent` is a closed interface: every property is explicitly
 * named, so TypeScript refuses a direct cast `event as Record<string, unknown>`
 * because the two types don't structurally overlap enough for TS to consider
 * the cast safe.
 *
 * The canonical fix is a two-hop cast through `unknown`:
 *   `(event as unknown) as Record<string, any>`
 * but that pattern scatters the type-unsafe widening across call-sites and
 * makes the intent opaque. This helper centralises the widening, documents
 * *why* it is safe (the result is a read-only snapshot of the already-redacted
 * broadcast payload — no new data escapes), and gives callers a properly-typed
 * return value without suppressing errors at every use-site.
 *
 * **Safety guarantee**
 *
 * The input must already have passed through `redactForBroadcast()`, which
 * enforces the NEVER_BROADCAST allowlist and the assertMetadataOnly floor.
 * `toFleetEventJSON` does not perform additional redaction — it only widens
 * the type for structural inspection.
 *
 * @param event - A `FleetRealtimeEvent` returned by `redactForBroadcast`.
 * @returns     A plain object with an index signature, suitable for dynamic
 *              key access. The returned object is a shallow copy; mutating it
 *              does not affect the original event.
 */
export function toFleetEventJSON(event: FleetRealtimeEvent): Record<string, any> {
  // Spread into a fresh object so callers get a stable plain object rather
  // than a reference to the original. The double-cast through `unknown` is
  // intentional — see JSDoc above.
  return { ...(event as unknown as Record<string, any>) };
}

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
export function redactForBroadcast(
  row: ActivityEventInsert,
  costImpact?: CostImpactFields,
): FleetRealtimeEvent {
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

  // Attach cost-impact fields when provided — pure numeric, privacy-safe.
  if (costImpact) {
    safe.user_cost_millicents    = costImpact.user_cost_millicents;
    safe.team_avg_millicents     = costImpact.team_avg_millicents;
    safe.peer_divergence_ratio   = costImpact.peer_divergence_ratio;
    safe.peer_divergence_severity = costImpact.peer_divergence_severity;
  }

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
 * @param userId             - owner of the events; channel is `fleet-events:{userId}`
 * @param rows               - all activity rows from this OTLP batch; non-fleet rows
 *                             are filtered out before broadcast.
 * @param teamAvgMillicents  - optional team average cost-per-event (millicents) for
 *                             peer-divergence computation. When provided, each event
 *                             gets user_cost_millicents / team_avg_millicents /
 *                             peer_divergence_ratio appended to the broadcast payload.
 */
export async function pushFleetEvents(
  userId: string,
  rows: ActivityEventInsert[],
  teamAvgMillicents?: number,
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
      // Compute cost-impact fields when a team average is available.
      const costImpact =
        teamAvgMillicents !== undefined
          ? computeCostImpactFields(row.cost_millicents ?? 0, teamAvgMillicents)
          : undefined;
      payload = redactForBroadcast(row, costImpact);
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
