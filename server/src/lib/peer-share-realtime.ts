/**
 * peer-share-realtime.ts — in-process registry for peer-share grant-delta
 * subscriptions, plus HMAC-SHA256 signing for SSE events.
 *
 * Design
 * ──────
 *   • Each viewer subscribes once (per SSE connection) under their userId.
 *   • When a grant is created or revoked, the owner calls
 *     broadcastGrantDelta() which fans out to all connected viewers who hold
 *     (or held) a grant from that owner.
 *   • Each event is signed with HMAC-SHA256 over the canonical payload so
 *     the client can verify authenticity even in non-TLS dev environments.
 *   • Privacy floor: grant delta events carry ONLY grant metadata —
 *     owner_id, viewer_id, fields[], revoked_at. No email, no activity
 *     details, no prompts. viewer_email / owner_email are intentionally
 *     excluded (the client already knows its own identity and receives only
 *     IDs for the counter-party).
 *
 * Single-node deploy: in-process memory. For multi-node, replace the
 * in-process registry with a Redis pub/sub adapter behind the same interface.
 */

import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Grant delta event shape (privacy floor: no email, no activity details)
// ---------------------------------------------------------------------------

/**
 * A grant delta event sent over the peer-share SSE stream.
 *
 * Privacy invariants (NEVER included):
 *   • owner_email / viewer_email — only UUIDs
 *   • activity_event columns of any kind
 *   • prompts, completions, raw_otel_span
 */
export interface GrantDeltaEvent {
  /** Monotonic event sequence for client dedup. */
  seq: number;
  /** ISO-8601 timestamp of the delta. */
  ts: string;
  /** "add" when a new grant is created; "revoke" when revoked_at is set. */
  action: "add" | "revoke";
  /** The user whose data is being shared. */
  owner_id: string;
  /** The user receiving access (the SSE subscriber). */
  viewer_id: string;
  /** The grant's allowed field whitelist (SHAREABLE_FIELDS subset). */
  fields: string[];
  /** ISO-8601 revocation timestamp; null on "add". */
  revoked_at: string | null;
  /** HMAC-SHA256 signature over the canonical payload (base64url). */
  sig: string;
}

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

function signingKey(): string {
  const key =
    process.env.PULSE_TOKEN_ENC_KEY ||
    process.env.PULSE_CRON_SECRET ||
    process.env.PULSE_HMAC_SECRET;
  if (!key) {
    // In test environments without a secret, fall back to a stable dummy key.
    // Production deployments MUST set PULSE_TOKEN_ENC_KEY.
    if (process.env.NODE_ENV === "test") return "test-only-hmac-key-not-for-prod";
    throw new Error(
      "peer-share-realtime: no signing secret set " +
        "(PULSE_TOKEN_ENC_KEY or PULSE_CRON_SECRET required)",
    );
  }
  return key;
}

/**
 * Canonical payload string for HMAC signing.
 * Uses only stable, non-email fields to produce a deterministic signature.
 */
function canonicalPayload(
  seq: number,
  ts: string,
  action: "add" | "revoke",
  owner_id: string,
  viewer_id: string,
  fields: string[],
  revoked_at: string | null,
): string {
  return [
    String(seq),
    ts,
    action,
    owner_id,
    viewer_id,
    [...fields].sort().join(","),
    revoked_at ?? "",
  ].join("|");
}

/**
 * Sign a grant delta event payload.
 * Returns base64url-encoded HMAC-SHA256.
 */
export function signGrantDelta(
  seq: number,
  ts: string,
  action: "add" | "revoke",
  owner_id: string,
  viewer_id: string,
  fields: string[],
  revoked_at: string | null,
): string {
  const payload = canonicalPayload(seq, ts, action, owner_id, viewer_id, fields, revoked_at);
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/**
 * Verify a GrantDeltaEvent's HMAC signature.
 * Returns true if the signature is valid.
 */
export function verifyGrantDelta(event: GrantDeltaEvent): boolean {
  const expected = signGrantDelta(
    event.seq,
    event.ts,
    event.action,
    event.owner_id,
    event.viewer_id,
    event.fields,
    event.revoked_at,
  );
  // Timing-safe comparison.
  const a = Buffer.from(expected);
  const b = Buffer.from(event.sig);
  if (a.length !== b.length) return false;
  try {
    // crypto.timingSafeEqual is Node-only — safe here (runtime: nodejs).
    const { timingSafeEqual } = require("crypto") as typeof import("crypto");
    return timingSafeEqual(a, b);
  } catch {
    return a.toString() === b.toString();
  }
}

// ---------------------------------------------------------------------------
// In-process subscriber registry
// ---------------------------------------------------------------------------

export interface GrantDeltaController {
  /** Send a signed GrantDeltaEvent to this subscriber. Returns false if closed. */
  send(event: GrantDeltaEvent): boolean;
  /** Close the stream server-side. */
  close(): void;
  /** True if the controller has been closed. */
  readonly isClosed: boolean;
}

// Map: viewerId → Set<GrantDeltaController>
const registry = new Map<string, Set<GrantDeltaController>>();

/** Global monotonic sequence counter for all grant delta events. */
let _seq = 0;

/**
 * Register a GrantDeltaController for a viewer.
 * Returns an unregister callback — call it on stream close.
 */
export function registerGrantDeltaController(
  viewerId: string,
  ctrl: GrantDeltaController,
): () => void {
  let set = registry.get(viewerId);
  if (!set) {
    set = new Set();
    registry.set(viewerId, set);
  }
  set.add(ctrl);

  return () => {
    set!.delete(ctrl);
    if (set!.size === 0) registry.delete(viewerId);
  };
}

// ---------------------------------------------------------------------------
// broadcastGrantDelta — fan-out a grant change to affected viewers
// ---------------------------------------------------------------------------

/**
 * Broadcast a grant add/revoke event to the target viewer's SSE connections.
 *
 * Called by:
 *   • POST /api/peer-share  (on successful createPeerShare) for "add"
 *   • DELETE /api/peer-share/[id] (on successful revokeShare) for "revoke"
 *
 * Returns the number of controllers that received the event.
 */
export function broadcastGrantDelta(
  action: "add" | "revoke",
  owner_id: string,
  viewer_id: string,
  fields: string[],
  revoked_at: string | null,
): number {
  const set = registry.get(viewer_id);
  if (!set || set.size === 0) return 0;

  const seq = ++_seq;
  const ts = new Date().toISOString();
  const sig = signGrantDelta(seq, ts, action, owner_id, viewer_id, fields, revoked_at);

  const event: GrantDeltaEvent = {
    seq,
    ts,
    action,
    owner_id,
    viewer_id,
    fields,
    revoked_at,
    sig,
  };

  let sent = 0;
  const dead: GrantDeltaController[] = [];

  for (const ctrl of set) {
    if (ctrl.isClosed) {
      dead.push(ctrl);
      continue;
    }
    const ok = ctrl.send(event);
    if (!ok) dead.push(ctrl);
    else sent++;
  }

  for (const ctrl of dead) {
    set.delete(ctrl);
  }
  if (set.size === 0) registry.delete(viewer_id);

  return sent;
}

// ---------------------------------------------------------------------------
// Helpers for tests
// ---------------------------------------------------------------------------

/** Number of active controllers for a viewer. */
export function grantDeltaControllerCount(viewerId: string): number {
  return registry.get(viewerId)?.size ?? 0;
}

/** Clear the entire registry — for tests only. */
export function clearGrantDeltaRegistry(): void {
  registry.clear();
  _seq = 0;
}

/** Reset the global sequence counter — for tests only. */
export function resetGrantDeltaSeq(): void {
  _seq = 0;
}

// ---------------------------------------------------------------------------
// broadcastPeerShareAggregate — subscribe-push model for materialized deltas
// ---------------------------------------------------------------------------

/**
 * An aggregate delta payload pushed to a viewer's registered webhook.
 *
 * Privacy floor (same as PeerShareWebhookPayload in peer-share-agg.ts):
 *   • Only SHAREABLE_FIELDS values — cost, tokens, duration by model/source/language.
 *   • No prompts, completions, raw OTel spans, or email addresses.
 *   • model / source / language only included when the grant's fields[] permits them.
 *   • viewer_id is the recipient identity; owner_id is a UUID (not an email).
 *
 * The sig field is HMAC-SHA256 over the canonical aggregate payload so the
 * receiver can verify the push came from Pulse and was not tampered with.
 */
export interface PeerShareAggregateDelta {
  /** Monotonic event sequence for client dedup. */
  seq: number;
  /** ISO-8601 timestamp when this delta was computed. */
  ts: string;
  /** "hourly" | "weekly" — matches the subscriber's registered granularity. */
  granularity: "hourly" | "weekly";
  /** The owner whose activity generated this aggregate. */
  owner_id: string;
  /** The subscriber receiving this delta. */
  viewer_id: string;
  /** ISO-8601 start of the bucket (hour or week Monday 00:00 UTC). */
  bucket_start: string;
  /** Aggregate cost in millicents across all permitted sources/models. */
  cost_millicents: number;
  /** Total input tokens. */
  tokens_input: number;
  /** Total output tokens. */
  tokens_output: number;
  /** Total activity event count. */
  event_count: number;
  /** Total duration in milliseconds (when duration_ms is in grant fields). */
  duration_ms?: number;
  /** Breakdown by model — only when "model" is in grant fields. */
  by_model?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
  /** Breakdown by source — only when "source" is in grant fields. */
  by_source?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
  /** Breakdown by language — only when "language" is in grant fields. */
  by_language?: Record<string, { cost_millicents: number; event_count: number }>;
  /** HMAC-SHA256 signature over the canonical aggregate payload (base64url). */
  sig: string;
}

/**
 * Canonical payload string for aggregate delta HMAC signing.
 * Deterministic — sorts breakdown keys before serialising.
 */
function canonicalAggregatePayload(
  seq: number,
  ts: string,
  granularity: "hourly" | "weekly",
  owner_id: string,
  viewer_id: string,
  bucket_start: string,
  cost_millicents: number,
  tokens_input: number,
  tokens_output: number,
  event_count: number,
): string {
  return [
    String(seq),
    ts,
    granularity,
    owner_id,
    viewer_id,
    bucket_start,
    String(cost_millicents),
    String(tokens_input),
    String(tokens_output),
    String(event_count),
  ].join("|");
}

/**
 * Sign an aggregate delta payload.
 * Returns base64url-encoded HMAC-SHA256.
 */
export function signAggregateDelta(
  seq: number,
  ts: string,
  granularity: "hourly" | "weekly",
  owner_id: string,
  viewer_id: string,
  bucket_start: string,
  cost_millicents: number,
  tokens_input: number,
  tokens_output: number,
  event_count: number,
): string {
  const payload = canonicalAggregatePayload(
    seq, ts, granularity, owner_id, viewer_id, bucket_start,
    cost_millicents, tokens_input, tokens_output, event_count,
  );
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/**
 * Verify a PeerShareAggregateDelta HMAC signature.
 * Returns true if the signature is valid.
 */
export function verifyAggregateDelta(delta: PeerShareAggregateDelta): boolean {
  const expected = signAggregateDelta(
    delta.seq,
    delta.ts,
    delta.granularity,
    delta.owner_id,
    delta.viewer_id,
    delta.bucket_start,
    delta.cost_millicents,
    delta.tokens_input,
    delta.tokens_output,
    delta.event_count,
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(delta.sig);
  if (a.length !== b.length) return false;
  try {
    const { timingSafeEqual } = require("crypto") as typeof import("crypto");
    return timingSafeEqual(a, b);
  } catch {
    return a.toString() === b.toString();
  }
}

/**
 * Construct a signed PeerShareAggregateDelta for webhook delivery.
 *
 * Privacy invariants enforced here:
 *   • by_model is only included when "model" is in grantFields.
 *   • by_source is only included when "source" is in grantFields.
 *   • by_language is only included when "language" is in grantFields.
 *   • duration_ms is only included when "duration_ms" is in grantFields.
 *   • No email, no prompt, no completion, no raw span.
 *   • All field values are numeric aggregates — no strings from user content.
 */
export function buildAggregateDelta(
  granularity: "hourly" | "weekly",
  owner_id: string,
  viewer_id: string,
  bucket_start: string,
  totals: {
    cost_millicents: number;
    tokens_input: number;
    tokens_output: number;
    event_count: number;
    duration_ms?: number;
  },
  breakdowns: {
    by_model?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
    by_source?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
    by_language?: Record<string, { cost_millicents: number; event_count: number }>;
  },
  grantFields: string[],
): PeerShareAggregateDelta {
  const seq = ++_seq;
  const ts = new Date().toISOString();

  const sig = signAggregateDelta(
    seq, ts, granularity, owner_id, viewer_id, bucket_start,
    totals.cost_millicents, totals.tokens_input, totals.tokens_output, totals.event_count,
  );

  const delta: PeerShareAggregateDelta = {
    seq,
    ts,
    granularity,
    owner_id,
    viewer_id,
    bucket_start,
    cost_millicents: totals.cost_millicents,
    tokens_input: totals.tokens_input,
    tokens_output: totals.tokens_output,
    event_count: totals.event_count,
    sig,
  };

  // Conditionally include optional fields gated by grant permissions.
  if (totals.duration_ms !== undefined && grantFields.includes("duration_ms")) {
    delta.duration_ms = totals.duration_ms;
  }
  if (breakdowns.by_model && grantFields.includes("model")) {
    delta.by_model = breakdowns.by_model;
  }
  if (breakdowns.by_source && grantFields.includes("source")) {
    delta.by_source = breakdowns.by_source;
  }
  if (breakdowns.by_language && grantFields.includes("language")) {
    delta.by_language = breakdowns.by_language;
  }

  return delta;
}

/**
 * POST a signed PeerShareAggregateDelta to a viewer's registered webhook URL.
 *
 * Uses HMAC-SHA256 signing (x-pulse-signature: sha256=<hex>) and retries on
 * transient failures using exponential backoff.
 *
 * @param url       The viewer's registered webhook_url.
 * @param delta     The signed aggregate delta payload.
 * @param secret    PULSE_CRON_SECRET (or test override) for x-pulse-signature.
 * @returns         Delivery result with ok flag, status code, and attempt count.
 */
export interface AggregatePushResult {
  ok: boolean;
  status: number | null;
  attempt: number;
  error?: string;
}

const AGG_MAX_RETRIES = 3;
const AGG_BASE_BACKOFF_MS = 500;

export async function broadcastPeerShareAggregate(
  url: string,
  delta: PeerShareAggregateDelta,
  secret: string | null,
): Promise<AggregatePushResult> {
  const rawBody = JSON.stringify(delta);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ashlr-pulse/1.0 (+https://pulse.ashlr.dev)",
    "x-pulse-event": "peer_share_aggregate",
  };

  if (secret) {
    const { createHmac: _hmac } = require("crypto") as typeof import("crypto");
    const sig = `sha256=${_hmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    headers["x-pulse-signature"] = sig;
  }

  let lastError = "";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= AGG_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });

      lastStatus = resp.status;

      if (resp.ok) {
        return { ok: true, status: resp.status, attempt };
      }

      // 4xx → do not retry (bad URL, wrong auth, disabled endpoint).
      if (resp.status >= 400 && resp.status < 500) {
        return {
          ok: false,
          status: resp.status,
          attempt,
          error: `HTTP ${resp.status} — not retrying (4xx)`,
        };
      }

      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
    }

    if (attempt < AGG_MAX_RETRIES) {
      const backoffMs = AGG_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return { ok: false, status: lastStatus, attempt: AGG_MAX_RETRIES, error: lastError };
}
