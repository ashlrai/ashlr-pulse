/**
 * fleet-scorecard-webhook.ts — event evaluation + signed delivery for the
 * fleet scorecard webhook sink.
 *
 * Called by /api/cron/fleet-scorecard-webhook once per day. For each org
 * that has a webhook_url configured, this module:
 *   1. Fetches yesterday's fleet metrics snapshot.
 *   2. Evaluates each subscribed event condition against the snapshot.
 *   3. If any condition fires, POSTs a JSON payload to webhook_url,
 *      optionally signing it with HMAC-SHA256(secret, body).
 *   4. Retries on 5xx with exponential backoff (up to 3 attempts).
 *
 * PRIVACY FLOOR: the webhook payload contains ONLY metadata — counts, costs,
 * enums, thresholds, and gate statuses. It never includes prompts, code,
 * completions, diffs, repo names with file paths, or any user-authored
 * content. This is enforced by buildWebhookPayload which reads only from
 * FleetMetrics (which is itself metadata-only).
 *
 * HMAC signing: when webhook_secret is configured, every delivery includes:
 *   x-pulse-signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>
 * The receiving server verifies this to ensure the request originated from
 * Pulse and was not tampered with in transit.
 */

import { createHmac } from "crypto";
import type { FleetMetrics } from "./fleet-oversight";
import type { WebhookEventSlug } from "./webhook-db";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Payload shape (privacy floor: metadata only).
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  /** The event slug that triggered this delivery. */
  event: WebhookEventSlug;
  org_id: string;
  /** UTC window the metrics cover: yesterday 00:00–24:00 UTC. */
  window: { start: string; end: string; days: number };
  /**
   * Metadata-only snapshot. Contains only numeric counters, rates, and
   * boolean flags — never any user-authored content.
   */
  metrics_snapshot: MetricsSnapshot;
  /** The threshold that was crossed to fire this event. */
  threshold: number | string;
  /** The actual measured value. */
  actual: number | string;
  triggered_at: string;
}

/**
 * Metadata-only metrics snapshot embedded in the payload.
 * PRIVACY: this interface intentionally excludes byRepo, byOwner,
 * and byEngine breakdowns that could indirectly identify content.
 * Only aggregate counts, rates, and costs are included.
 */
export interface MetricsSnapshot {
  proposals: number;
  applied: number;
  rejected: number;
  pending: number;
  approval_rate: number;
  rejection_rate: number;
  cost_usd: number;
  active_agents: number;
  repos_touched: number;
  stale_review_count: number;
  failed_commands: number;
  spend_usd: number;
  budget_cap_usd: number | null;
  over_budget: boolean;
  trend: FleetMetrics["trend"];
}

// ---------------------------------------------------------------------------
// Privacy-safe snapshot builder. NEVER add user-content fields here.
// ---------------------------------------------------------------------------

export function buildMetricsSnapshot(m: FleetMetrics): MetricsSnapshot {
  return {
    proposals: m.productivity.proposals,
    applied: m.quality.applied,
    rejected: m.quality.rejected,
    pending: m.quality.pending,
    approval_rate: m.quality.approvalRate,
    rejection_rate: m.quality.rejectionRate,
    cost_usd: m.productivity.costUsd,
    active_agents: m.productivity.activeAgents,
    repos_touched: m.productivity.reposTouched,
    stale_review_count: m.quality.staleReviewCount,
    failed_commands: m.safety.failedCommands,
    spend_usd: m.safety.spendUsd,
    budget_cap_usd: m.safety.budgetCapUsd,
    over_budget: m.safety.overBudget,
    trend: m.trend,
  };
}

// ---------------------------------------------------------------------------
// Event condition evaluation.
// Thresholds mirror GATE_THRESHOLDS in fleet-quality-gates.ts.
// ---------------------------------------------------------------------------

/** Approval rate floor that triggers fleet_quality_alert. */
export const QUALITY_ALERT_APPROVAL_THRESHOLD = 0.8;
/** Stale review count that triggers stale_review. */
export const STALE_REVIEW_THRESHOLD = 5;
/** Min resolved proposals before quality alert fires (avoid false positives on empty windows). */
const MIN_RESOLVED_FOR_QUALITY = 3;

export interface FiredEvent {
  event: WebhookEventSlug;
  threshold: number | string;
  actual: number | string;
}

/**
 * Evaluate which subscribed events fire for the given metrics snapshot.
 * Pure function — no I/O.
 *
 * @param snapshot  The metrics snapshot for the window.
 * @param events    The org's subscribed event slugs.
 * @returns         Array of events that fired (may be empty).
 */
export function evaluateWebhookEvents(
  snapshot: MetricsSnapshot,
  events: WebhookEventSlug[],
): FiredEvent[] {
  const fired: FiredEvent[] = [];

  for (const event of events) {
    switch (event) {
      case "fleet_quality_alert": {
        // Fire when approval rate falls below threshold AND there were enough
        // resolved proposals to make the rate meaningful.
        const resolved = snapshot.applied + snapshot.rejected;
        if (
          resolved >= MIN_RESOLVED_FOR_QUALITY &&
          snapshot.approval_rate < QUALITY_ALERT_APPROVAL_THRESHOLD
        ) {
          fired.push({
            event,
            threshold: QUALITY_ALERT_APPROVAL_THRESHOLD,
            actual: snapshot.approval_rate,
          });
        }
        break;
      }

      case "budget_exceeded": {
        if (snapshot.over_budget && snapshot.budget_cap_usd !== null) {
          fired.push({
            event,
            threshold: snapshot.budget_cap_usd,
            actual: snapshot.spend_usd,
          });
        }
        break;
      }

      case "stale_review": {
        if (snapshot.stale_review_count >= STALE_REVIEW_THRESHOLD) {
          fired.push({
            event,
            threshold: STALE_REVIEW_THRESHOLD,
            actual: snapshot.stale_review_count,
          });
        }
        break;
      }

      case "agent_down": {
        // Fire when there were active agents before (proposals > 0) but
        // now active_agents = 0 — the fleet appears to have gone dark.
        if (snapshot.active_agents === 0 && snapshot.proposals > 0) {
          fired.push({
            event,
            threshold: 1,   // at least 1 active agent expected
            actual: 0,
          });
        }
        break;
      }
    }
  }

  return fired;
}

// ---------------------------------------------------------------------------
// HMAC signing.
// ---------------------------------------------------------------------------

/**
 * Sign a raw body string with HMAC-SHA256. Returns the signature in the
 * format "sha256=<hex>" matching the GitHub webhook signature convention.
 */
export function signPayload(secret: string, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${mac}`;
}

// ---------------------------------------------------------------------------
// HTTP delivery with exponential backoff retry.
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export type DeliveryResult =
  | { ok: true; status: number; attempt: number }
  | { ok: false; status: number | null; attempt: number; error: string };

/**
 * POST payload to the webhook endpoint. Retries up to MAX_RETRIES times on
 * 5xx responses with exponential backoff. 4xx responses are NOT retried
 * (they indicate a configuration problem).
 *
 * Signs the body with HMAC-SHA256 when secret is provided.
 */
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret: string | null,
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ashlr-pulse/1.0 (+https://pulse.ashlr.dev)",
    "x-pulse-event": payload.event,
  };
  if (secret) {
    headers["x-pulse-signature"] = signPayload(secret, rawBody);
  }

  let lastError = "";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: rawBody,
        // Abort after 10s — external webhooks should respond quickly.
        signal: AbortSignal.timeout(10_000),
      });

      lastStatus = resp.status;

      if (resp.ok) {
        return { ok: true, status: resp.status, attempt };
      }

      // 4xx → do not retry (bad URL, wrong auth, etc.)
      if (resp.status >= 400 && resp.status < 500) {
        return {
          ok: false,
          status: resp.status,
          attempt,
          error: `HTTP ${resp.status} — not retrying (4xx)`,
        };
      }

      // 5xx → retry after backoff.
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
    }

    if (attempt < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      log.warn({
        msg: "fleet-scorecard-webhook: delivery failed, retrying",
        url,
        attempt,
        backoff_ms: backoffMs,
        error: lastError,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return { ok: false, status: lastStatus, attempt: MAX_RETRIES, error: lastError };
}
