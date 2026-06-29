/**
 * dashboard-sse-broadcast.ts — org-scoped SSE broadcast layer for /api/app/live.
 *
 * Manages multiple SSE streams per org, deduplicates anomalies within a 30s
 * window, and implements exponential backoff when clients fall behind.
 *
 * Design
 * ──────
 *   • Streams are keyed by orgId (not userId) so all org members see the
 *     same live feed. Per-connection filtering (repo scope, peer-share)
 *     happens at the controller level.
 *   • Anomaly dedup: each org keeps a Set<string> of event_id fingerprints
 *     seen in the last 30 s. Duplicate anomaly events are silently dropped.
 *   • Backpressure: if a controller's internal queue exceeds LAG_THRESHOLD
 *     the controller is considered lagging. On reconnect the lag is cleared
 *     and the client receives fresh events only (no replay).
 *   • Privacy: only SHAREABLE_FIELDS from peer-share-guard.ts ever appear
 *     in broadcast payloads. The route layer enforces this before calling
 *     broadcastToOrg().
 *
 * Single-node deploy: in-process memory is sufficient. For multi-node,
 * replace the in-process registry with a Redis pub/sub adapter behind the
 * same interface.
 */

import type { FleetRealtimeEvent } from "./fleet-realtime";
import type { RealtimeAnomaly } from "./realtime-anomaly";

// ---------------------------------------------------------------------------
// Public event types broadcast over the /api/app/live SSE stream
// ---------------------------------------------------------------------------

/** Activity event broadcast payload — SHAREABLE_FIELDS only. */
export interface LiveActivityEvent {
  /** Unique event ID (dedup key for the client). */
  event_id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Event source (e.g. "ashlr-fleet"). */
  source: string;
  /** Repository name (e.g. "acme/api"). */
  repo_name: string | null;
  /** Cost in millicents. */
  cost_millicents: number | null;
  /** Total tokens (input + output). */
  tokens_total: number | null;
  /** Tool call types array (e.g. ["Bash","Read"]). */
  tool_calls_types: string[] | null;
  /** Fleet event type (e.g. "proposal", "merge"). */
  fleet_event: string | null;
  /** Fleet outcome (e.g. "pending", "approved", "fail"). */
  fleet_outcome: string | null;
  /** Fleet owner identifier. */
  fleet_owner: string | null;
  /** Model used. */
  model: string | null;
  /** Provider. */
  provider: string | null;
  /** Duration in ms. */
  duration_ms: number | null;
}

/** Anomaly event broadcast payload. */
export interface LiveAnomalyEvent {
  /** Unique event ID (dedup key). */
  event_id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** The anomaly details (no user content). */
  anomaly: RealtimeAnomaly;
}

/** SSE event types sent on /api/app/live. */
export type LiveEvent =
  | { type: "activity"; payload: LiveActivityEvent }
  | { type: "anomaly"; payload: LiveAnomalyEvent }
  | { type: "heartbeat"; ts: string };

// ---------------------------------------------------------------------------
// Backpressure constants
// ---------------------------------------------------------------------------

/**
 * Number of pending enqueue calls beyond which a controller is considered
 * lagging. We track this with a soft counter since ReadableStream's
 * backpressure is opaque to us.
 */
const LAG_THRESHOLD = 50;

// Anomaly dedup window: 30 seconds.
const ANOMALY_DEDUP_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// OrgBroadcastController — per-connection abstraction
// ---------------------------------------------------------------------------

export interface OrgBroadcastController {
  /** Unique connection ID (for debugging/metrics). */
  readonly connectionId: string;
  /**
   * Send a live event to this connection.
   * Returns false if the stream is closed or lagging past LAG_THRESHOLD.
   */
  send(event: LiveEvent): boolean;
  /** Close the stream server-side. */
  close(): void;
  /** True if the controller has been closed. */
  readonly isClosed: boolean;
  /** True if the controller is lagging (enqueue count > LAG_THRESHOLD). */
  readonly isLagging: boolean;
  /** Reset lag counter — called on reconnect. */
  resetLag(): void;
}

// ---------------------------------------------------------------------------
// Internal OrgState — per-org registry + anomaly dedup
// ---------------------------------------------------------------------------

interface AnomalyRecord {
  eventId: string;
  expiresAt: number;
}

interface OrgState {
  controllers: Set<OrgBroadcastController>;
  /** Anomaly event_ids seen within the dedup window. */
  anomalyDedup: Map<string, AnomalyRecord>;
}

// Module-level registry (single-node in-process).
const orgRegistry = new Map<string, OrgState>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOrCreateOrgState(orgId: string): OrgState {
  let state = orgRegistry.get(orgId);
  if (!state) {
    state = { controllers: new Set(), anomalyDedup: new Map() };
    orgRegistry.set(orgId, state);
  }
  return state;
}

/**
 * Prune expired anomaly dedup entries for an org.
 * Called lazily before each broadcast to avoid holding a timer.
 */
function pruneAnomalyDedup(state: OrgState): void {
  const now = Date.now();
  for (const [key, record] of state.anomalyDedup) {
    if (record.expiresAt <= now) {
      state.anomalyDedup.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// registerOrgController — register a controller for an org
// ---------------------------------------------------------------------------

/**
 * Register a broadcast controller under orgId.
 * Returns an unregister function — call it on stream close / cancel.
 */
export function registerOrgController(
  orgId: string,
  ctrl: OrgBroadcastController,
): () => void {
  const state = getOrCreateOrgState(orgId);
  state.controllers.add(ctrl);

  return () => {
    state.controllers.delete(ctrl);
    if (state.controllers.size === 0) {
      orgRegistry.delete(orgId);
    }
  };
}

// ---------------------------------------------------------------------------
// broadcastToOrg — fan-out events to all org controllers
// ---------------------------------------------------------------------------

/**
 * Broadcast a LiveEvent to all active controllers for orgId.
 *
 * Anomaly events are deduplicated across the 30s window — duplicate
 * event_ids are silently dropped. Dead/lagging controllers are pruned.
 *
 * Returns the number of controllers that received the event.
 */
export function broadcastToOrg(orgId: string, event: LiveEvent): number {
  const state = orgRegistry.get(orgId);
  if (!state || state.controllers.size === 0) return 0;

  // Anomaly dedup check.
  if (event.type === "anomaly") {
    pruneAnomalyDedup(state);
    const { event_id } = event.payload;
    if (state.anomalyDedup.has(event_id)) {
      return 0; // duplicate within dedup window — drop
    }
    state.anomalyDedup.set(event_id, {
      eventId: event_id,
      expiresAt: Date.now() + ANOMALY_DEDUP_WINDOW_MS,
    });
  }

  let sent = 0;
  const dead: OrgBroadcastController[] = [];

  for (const ctrl of state.controllers) {
    if (ctrl.isClosed) {
      dead.push(ctrl);
      continue;
    }
    const ok = ctrl.send(event);
    if (!ok) {
      dead.push(ctrl);
    } else {
      sent++;
    }
  }

  // Prune dead/lagging controllers.
  for (const ctrl of dead) {
    state.controllers.delete(ctrl);
  }
  if (state.controllers.size === 0) {
    orgRegistry.delete(orgId);
  }

  return sent;
}

// ---------------------------------------------------------------------------
// broadcastActivityBatch — convenience wrapper for activity events
// ---------------------------------------------------------------------------

/**
 * Broadcast a batch of FleetRealtimeEvents (already privacy-stripped) as
 * LiveActivityEvent payloads to all org subscribers.
 *
 * @param orgId  The org to broadcast to.
 * @param events Privacy-safe FleetRealtimeEvents (from redactForBroadcast).
 * @returns      Total controller deliveries.
 */
export function broadcastActivityBatch(
  orgId: string,
  events: FleetRealtimeEvent[],
): number {
  let total = 0;
  for (const e of events) {
    const liveEvent: LiveEvent = {
      type: "activity",
      payload: toActivityEvent(e),
    };
    total += broadcastToOrg(orgId, liveEvent);
  }
  return total;
}

// ---------------------------------------------------------------------------
// broadcastAnomalyBatch — convenience wrapper for anomaly events
// ---------------------------------------------------------------------------

/**
 * Broadcast a batch of RealtimeAnomaly objects as LiveAnomalyEvent payloads
 * to all org subscribers. Dedup is applied per event_id within 30s.
 *
 * @param orgId     The org to broadcast to.
 * @param anomalies Anomaly objects from deriveAnomalies().
 * @returns         Total controller deliveries (after dedup).
 */
export function broadcastAnomalyBatch(
  orgId: string,
  anomalies: RealtimeAnomaly[],
): number {
  let total = 0;
  const now = new Date().toISOString();
  for (const anomaly of anomalies) {
    // Derive a stable event_id from the anomaly kind + repo + user + ts minute.
    const minute = now.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const eventId = `${anomaly.kind}:${anomaly.repo_name ?? "org"}:${anomaly.user_id ?? "all"}:${minute}`;
    const liveEvent: LiveEvent = {
      type: "anomaly",
      payload: {
        event_id: eventId,
        ts: now,
        anomaly,
      },
    };
    total += broadcastToOrg(orgId, liveEvent);
  }
  return total;
}

// ---------------------------------------------------------------------------
// toActivityEvent — FleetRealtimeEvent → LiveActivityEvent
// ---------------------------------------------------------------------------

/**
 * Convert a privacy-safe FleetRealtimeEvent to a LiveActivityEvent.
 * Computes tokens_total and derives event_id. Only SHAREABLE_FIELDS included.
 */
export function toActivityEvent(e: FleetRealtimeEvent): LiveActivityEvent {
  // Derive a stable event_id from source + ts + repo_name + fleet_event.
  const eventId = [
    e.source,
    e.ts,
    e.repo_name ?? "",
    e.fleet_event ?? "",
    e.fleet_owner ?? "",
  ]
    .join("|")
    .replace(/\s+/g, "_");

  return {
    event_id: eventId,
    ts: e.ts,
    source: e.source,
    repo_name: e.repo_name ?? null,
    cost_millicents: e.cost_millicents ?? null,
    tokens_total:
      e.tokens_input !== null || e.tokens_output !== null
        ? (e.tokens_input ?? 0) + (e.tokens_output ?? 0)
        : null,
    tool_calls_types: null, // FleetRealtimeEvent doesn't carry this; route layer adds if available
    fleet_event: e.fleet_event ?? null,
    fleet_outcome: e.fleet_outcome ?? null,
    fleet_owner: e.fleet_owner ?? null,
    model: e.model ?? null,
    provider: e.provider ?? null,
    duration_ms: e.duration_ms ?? null,
  };
}

// ---------------------------------------------------------------------------
// orgControllerCount — for tests / metrics
// ---------------------------------------------------------------------------

/** Number of active controllers for an org. */
export function orgControllerCount(orgId: string): number {
  return orgRegistry.get(orgId)?.controllers.size ?? 0;
}

/** Clear the entire registry — for tests only. */
export function clearOrgRegistry(): void {
  orgRegistry.clear();
}

/** Anomaly dedup set size for an org — for tests. */
export function orgAnomalyDedupSize(orgId: string): number {
  return orgRegistry.get(orgId)?.anomalyDedup.size ?? 0;
}
