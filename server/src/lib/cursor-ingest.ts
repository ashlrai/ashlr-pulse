/**
 * cursor-ingest.ts — poll Cursor's organisation usage API and emit
 * OTLP-compatible activity events into activity_event.
 *
 * ── API surface ─────────────────────────────────────────────────────────────
 * GET https://api.cursor.sh/api/v1/organizations/{org_id}/usage
 * Rate limit: 1 request/minute per org (enforced by caller via 60-second cache).
 * Auth: Authorization: Bearer <cursor_admin_token>
 *
 * ── Response shape ──────────────────────────────────────────────────────────
 * {
 *   sessions: [
 *     {
 *       id:            string,   // stable cursor session ID
 *       user_id:       string,   // cursor user identifier
 *       model:         string,   // e.g. "claude-sonnet-4-5" or "gpt-4o"
 *       tokens_input:  number,
 *       tokens_output: number,
 *       duration_ms:   number,
 *       ts:            string,   // ISO-8601
 *     }, …
 *   ]
 * }
 *
 * ── Privacy floor ───────────────────────────────────────────────────────────
 * Only ts, duration_ms, model, tokens, and cost are stored.
 * Code context, editor selections, and keystroke data are NEVER fetched or
 * stored — this is enforced by column absence in activity_event.
 *
 * ── Deduplication ───────────────────────────────────────────────────────────
 * Each Cursor session is hashed into a dedup_key:
 *   SHA-256(cursor_session_id + ":" + user_id + ":" + model + ":" + ts_second)
 * Re-polls are idempotent: activity_event has a unique index on
 * (user_id, dedup_key) WHERE dedup_key IS NOT NULL  [migration 0015].
 * We also set session_id to the same hash so the /sessions view can group
 * Cursor events as distinct IDE sessions.
 *
 * ── Model → provider mapping ────────────────────────────────────────────────
 * Models starting with "claude" → provider = "anthropic"
 * Models starting with "gpt" | "o1" | "o3" | "o4" → provider = "openai"
 * Everything else → provider = null
 */

import { createHash } from "node:crypto";
import { sql } from "./db";
import { costMillicents, normalizeModel, PRICE_VERSION } from "./pricing";
import { log } from "./logger";
import type { CursorOrgConfig } from "./cursor-auth";
import type { ActivityEventInsert } from "./otel-genai";

// ── Cursor API response types ────────────────────────────────────────────────

export interface CursorUsageSession {
  id: string;
  user_id: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  duration_ms: number;
  ts: string; // ISO-8601
}

export interface CursorUsageResponse {
  sessions: CursorUsageSession[];
}

// ── In-memory rate-limit cache ───────────────────────────────────────────────
// Ensures we honour the 1-req/min limit even if the cron fires more frequently.

const lastFetchAt = new Map<string, number>();
const FETCH_COOLDOWN_MS = 60_000; // 1 minute

function isCoolingDown(orgId: string): boolean {
  const last = lastFetchAt.get(orgId);
  if (!last) return false;
  return Date.now() - last < FETCH_COOLDOWN_MS;
}

// ── Provider inference ───────────────────────────────────────────────────────

export function inferProvider(model: string): "anthropic" | "openai" | null {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) {
    return "openai";
  }
  return null;
}

// ── Dedup key ────────────────────────────────────────────────────────────────

export function buildDedupKey(
  cursorSessionId: string,
  userId: string,
  model: string,
  ts: string,
): string {
  // Truncate ts to the second so minor sub-second jitter doesn't break dedup.
  const tsSecond = ts.slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
  return createHash("sha256")
    .update(`${cursorSessionId}:${userId}:${model}:${tsSecond}`)
    .digest("hex");
}

// ── Map raw session to ActivityEventInsert ───────────────────────────────────

export function sessionToActivityEvent(
  session: CursorUsageSession,
  pulseUserId: string,
): ActivityEventInsert {
  const dedupKey = buildDedupKey(session.id, session.user_id, session.model, session.ts);
  const normalModel = normalizeModel(session.model);
  const provider = inferProvider(session.model);
  const ts = new Date(session.ts);

  const cost = costMillicents({
    model: normalModel,
    tokens_input: session.tokens_input,
    tokens_output: session.tokens_output,
    ts,
  });

  return {
    ts: ts.toISOString(),
    user_id: pulseUserId,
    session_id: dedupKey,        // stable per-session ID for the /sessions view
    source: "cursor",
    provider,
    model: normalModel,
    duration_ms: session.duration_ms,
    tokens_input: session.tokens_input,
    tokens_output: session.tokens_output,
    tokens_reasoning: null,
    tokens_cache_read: null,
    tokens_cache_write: null,
    tokens_cache_5m_write: null,
    tokens_cache_1h_write: null,
    tool_calls_count: null,
    tool_calls_types: null,
    accepted_count: null,
    rejected_count: null,
    project_hash: null,
    repo_name: null,
    git_branch: null,
    language: null,
    tokens_saved: null,
    tokens_saved_breakdown: null,
    plugin_features: null,
    plugin_version: null,
    plugin_genome_hit_rate: null,
    span_id: null,               // Cursor doesn't emit OTLP span IDs
    cost_millicents: cost,
    pricing_version: cost != null ? PRICE_VERSION : null,
    dedup_key: dedupKey,
    fleet_event: null,
    fleet_outcome: null,
    fleet_owner: null,
    codex_plan_type: null,
    codex_originator: null,
    codex_parent_thread_id: null,
    codex_cli_version: null,
    codex_context_window: null,
    codex_rate_limit_primary_pct: null,
    codex_rate_limit_secondary_pct: null,
    codex_sandbox_policy: null,
    codex_approval_policy: null,
    codex_effort: null,
  };
}

// ── Public ingest entry point ─────────────────────────────────────────────────

export interface CursorIngestResult {
  org_id: string;
  sessions_fetched: number;
  events_inserted: number;
  skipped_cooldown: boolean;
  error?: string;
}

/**
 * Poll Cursor usage API for one org and upsert new activity events.
 *
 * @param orgConfig  Org metadata + decrypted Cursor admin token (from cursor-auth.ts)
 * @param pulseUserId  The Pulse user_id that owns the org (used as activity_event.user_id)
 */
export async function cursorIngest(
  orgConfig: CursorOrgConfig,
  pulseUserId: string,
): Promise<CursorIngestResult> {
  const { org_id, cursor_org_id, admin_token } = orgConfig;

  if (isCoolingDown(org_id)) {
    log.info({ msg: "cursor-ingest: skipping (cooldown)", org_id });
    return { org_id, sessions_fetched: 0, events_inserted: 0, skipped_cooldown: true };
  }

  // ── Fetch from Cursor API ──────────────────────────────────────────────────
  let sessions: CursorUsageSession[];
  try {
    const url = `https://api.cursor.sh/api/v1/organizations/${cursor_org_id}/usage`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${admin_token}`,
        Accept: "application/json",
      },
    });
    lastFetchAt.set(org_id, Date.now());

    if (!resp.ok) {
      const body = await resp.text().catch(() => "(unreadable)");
      const msg = `Cursor API ${resp.status}: ${body.slice(0, 200)}`;
      log.warn({ msg: "cursor-ingest: API error", org_id, status: resp.status });
      return { org_id, sessions_fetched: 0, events_inserted: 0, skipped_cooldown: false, error: msg };
    }

    const data = (await resp.json()) as CursorUsageResponse;
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ msg: "cursor-ingest: fetch failed", org_id, err: message });
    return {
      org_id,
      sessions_fetched: 0,
      events_inserted: 0,
      skipped_cooldown: false,
      error: message,
    };
  }

  if (sessions.length === 0) {
    return { org_id, sessions_fetched: 0, events_inserted: 0, skipped_cooldown: false };
  }

  // ── Map sessions → rows ────────────────────────────────────────────────────
  const rows = sessions.map((s) => sessionToActivityEvent(s, pulseUserId));

  // ── Upsert with ON CONFLICT DO NOTHING ────────────────────────────────────
  // activity_event has two unique indexes (migration 0007 + 0015):
  //   - (user_id, span_id) WHERE span_id IS NOT NULL
  //   - (user_id, dedup_key) WHERE dedup_key IS NOT NULL   ← Cursor uses this
  // ON CONFLICT DO NOTHING handles both; re-polls are fully idempotent.
  const db = sql();
  let inserted = 0;
  try {
    const result = await db`
      INSERT INTO activity_event ${db(rows, [
        "ts",
        "user_id",
        "session_id",
        "source",
        "provider",
        "model",
        "duration_ms",
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
        "tokens_cache_5m_write",
        "tokens_cache_1h_write",
        "tool_calls_count",
        "tool_calls_types",
        "accepted_count",
        "rejected_count",
        "project_hash",
        "repo_name",
        "git_branch",
        "language",
        "tokens_saved",
        "tokens_saved_breakdown",
        "plugin_features",
        "plugin_version",
        "plugin_genome_hit_rate",
        "span_id",
        "cost_millicents",
        "pricing_version",
        "dedup_key",
        "codex_plan_type",
        "codex_originator",
        "codex_parent_thread_id",
        "codex_cli_version",
        "codex_context_window",
        "codex_rate_limit_primary_pct",
        "codex_rate_limit_secondary_pct",
        "codex_sandbox_policy",
        "codex_approval_policy",
        "codex_effort",
        "fleet_event",
        "fleet_outcome",
        "fleet_owner",
      ])}
      ON CONFLICT DO NOTHING
    `;
    inserted = result.count ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ msg: "cursor-ingest: db insert failed", org_id, err: message });
    return {
      org_id,
      sessions_fetched: sessions.length,
      events_inserted: 0,
      skipped_cooldown: false,
      error: message,
    };
  }

  log.info({
    msg: "cursor-ingest: done",
    org_id,
    sessions_fetched: sessions.length,
    events_inserted: inserted,
  });

  return {
    org_id,
    sessions_fetched: sessions.length,
    events_inserted: inserted,
    skipped_cooldown: false,
  };
}
