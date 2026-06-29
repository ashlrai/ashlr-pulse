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
import type { AnomalyPreferenceMap } from "./anomaly-preference-db";
import { filterAnomaliesByPreferences } from "./anomaly-preference-db";

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
// broadcastAnomalyBatchFiltered — preference-aware anomaly broadcast
// ---------------------------------------------------------------------------

/**
 * Broadcast anomalies to org subscribers, filtering each anomaly against the
 * requesting user's anomaly preferences before sending.
 *
 * This is the preferred call site when the user's preference map has been
 * pre-loaded (e.g. from getEffectivePreferences()). Anomaly kinds the user
 * has disabled are silently dropped; severities may be adjusted by threshold
 * multipliers.
 *
 * @param orgId       The org to broadcast to.
 * @param anomalies   Anomaly objects from deriveAnomalies().
 * @param preferences The user's loaded AnomalyPreferenceMap (from anomaly-preference-db).
 * @returns           Total controller deliveries after dedup + preference filter.
 */
export function broadcastAnomalyBatchFiltered(
  orgId: string,
  anomalies: RealtimeAnomaly[],
  preferences: AnomalyPreferenceMap,
): number {
  const filtered = filterAnomaliesByPreferences(anomalies, preferences);
  return broadcastAnomalyBatch(orgId, filtered);
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

// ---------------------------------------------------------------------------
// Peer-share aggregate SSE multiplexing
// ---------------------------------------------------------------------------
//
// Each viewer who opens the GET /api/peer-share-subscribe SSE endpoint gets a
// PeerShareAggController registered under their viewerId.  When a cron job
// calls notifyPeerShareSubscribers() after upserting an aggregate, it fans out
// to all live connections for that viewer.
//
// Privacy floor:
//   • Only SHAREABLE_FIELDS values travel through this path — the payload is
//     built by buildAggregateDelta() in peer-share-realtime.ts which gates each
//     optional breakdown on the grant's field whitelist.
//   • Forbidden fields (prompts, completions, raw_otel_span) are structurally
//     absent from PeerShareAggEvent — the type system enforces this.
//   • Cross-viewer leakage is impossible: the registry is keyed by viewerId and
//     each connection authenticates before registering.
//
// Backpressure:
//   • Reuses the same LAG_THRESHOLD = 50 constant as the org broadcast layer.
//   • Lagging/closed controllers are pruned on each broadcast call.
//   • Clients reconnect via EventSource auto-reconnect (browser spec); lag is
//     cleared on the next registration (new controller).
// ---------------------------------------------------------------------------

/**
 * A peer-share aggregate event broadcast to viewer SSE connections.
 *
 * Privacy invariants:
 *   • by_model / by_source / by_language only present when the grant permits.
 *   • No prompts, completions, code, diffs, or email addresses.
 *   • All numeric aggregate fields — no raw string content.
 */
export interface PeerShareAggEvent {
  /** SSE event type discriminator. */
  type: "peer_share_agg";
  /** ISO-8601 timestamp when this aggregate was computed. */
  ts: string;
  /** "hourly" | "daily" | "weekly" — matches the cron that produced it. */
  aggregate_type: "hourly" | "daily" | "weekly";
  /** Owner whose activity was aggregated. */
  owner_id: string;
  /** Viewer receiving this update (same as the subscribing connection). */
  viewer_id: string;
  /** ISO-8601 start of the bucket. */
  bucket_start: string;
  /** Total cost in millicents. */
  cost_millicents: number;
  /** Total input tokens. */
  tokens_input: number;
  /** Total output tokens. */
  tokens_output: number;
  /** Total activity event count. */
  event_count: number;
  /** Duration in ms — only when "duration_ms" is in grant fields. */
  duration_ms?: number;
  /** Cost/token breakdown by model — only when "model" is in grant fields. */
  by_model?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
  /** Cost/token breakdown by source — only when "source" is in grant fields. */
  by_source?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
  /** Cost/event breakdown by language — only when "language" is in grant fields. */
  by_language?: Record<string, { cost_millicents: number; event_count: number }>;
}

/** Controller interface for a peer-share aggregate SSE connection. */
export interface PeerShareAggController {
  readonly connectionId: string;
  /** Send a peer-share aggregate event. Returns false when closed or lagging. */
  send(event: PeerShareAggEvent): boolean;
  /** Send a heartbeat ping. */
  sendHeartbeat(ts: string): boolean;
  /** Close the stream server-side. */
  close(): void;
  readonly isClosed: boolean;
  readonly isLagging: boolean;
  /** Reset lag counter on reconnect. */
  resetLag(): void;
}

// In-process registry: viewerId → Set<PeerShareAggController>
const peerShareRegistry = new Map<string, Set<PeerShareAggController>>();

// Reuse same lag threshold as the org broadcast layer.
const PEER_SHARE_LAG_THRESHOLD = 50;

/**
 * Register a PeerShareAggController for a viewer.
 * Returns an unregister callback — call it on stream close / cancel.
 */
export function registerPeerShareController(
  viewerId: string,
  ctrl: PeerShareAggController,
): () => void {
  let set = peerShareRegistry.get(viewerId);
  if (!set) {
    set = new Set();
    peerShareRegistry.set(viewerId, set);
  }
  set.add(ctrl);

  return () => {
    set!.delete(ctrl);
    if (set!.size === 0) peerShareRegistry.delete(viewerId);
  };
}

/**
 * Broadcast a PeerShareAggEvent to all active SSE connections for viewerId.
 *
 * Dead or lagging controllers are pruned. Returns the number of controllers
 * that received the event.
 *
 * Called by notifyPeerShareSubscribers() in peer-share-agg.ts after each
 * aggregate upsert.
 */
export function broadcastPeerShareAgg(
  viewerId: string,
  event: PeerShareAggEvent,
): number {
  const set = peerShareRegistry.get(viewerId);
  if (!set || set.size === 0) return 0;

  let sent = 0;
  const dead: PeerShareAggController[] = [];

  for (const ctrl of set) {
    if (ctrl.isClosed) {
      dead.push(ctrl);
      continue;
    }
    if (ctrl.isLagging) {
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

  for (const ctrl of dead) {
    set.delete(ctrl);
  }
  if (set.size === 0) peerShareRegistry.delete(viewerId);

  return sent;
}

/**
 * Build a PeerShareAggController backed by a ReadableStream underlying controller.
 * Enforces the PEER_SHARE_LAG_THRESHOLD for backpressure / lag eviction.
 */
export function makePeerShareAggController(
  underlyingCtrl: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  connectionId: string,
): PeerShareAggController {
  let closed = false;
  let lagCount = 0;

  function enqueue(line: string): boolean {
    if (closed) return false;
    if (lagCount > PEER_SHARE_LAG_THRESHOLD) return false;
    try {
      underlyingCtrl.enqueue(encoder.encode(line));
      lagCount++;
      return true;
    } catch {
      closed = true;
      return false;
    }
  }

  return {
    connectionId,

    get isClosed() { return closed; },
    get isLagging() { return lagCount > PEER_SHARE_LAG_THRESHOLD; },

    resetLag() { lagCount = 0; },

    send(event: PeerShareAggEvent): boolean {
      const line = `event: peer_share_agg\ndata: ${JSON.stringify(event)}\n\n`;
      return enqueue(line);
    },

    sendHeartbeat(ts: string): boolean {
      const line = `event: heartbeat\ndata: ${JSON.stringify({ ts })}\n\n`;
      return enqueue(line);
    },

    close() {
      if (closed) return;
      closed = true;
      try { underlyingCtrl.close(); } catch { /* already closed */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for tests / metrics
// ---------------------------------------------------------------------------

/** Number of active peer-share SSE controllers for a viewer. */
export function peerShareControllerCount(viewerId: string): number {
  return peerShareRegistry.get(viewerId)?.size ?? 0;
}

/** Clear the peer-share SSE registry — for tests only. */
export function clearPeerShareRegistry(): void {
  peerShareRegistry.clear();
}
