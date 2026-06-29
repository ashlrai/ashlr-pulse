/**
 * fleet-audit-export.ts — streaming CSV / JSONL export of the fleet audit log.
 *
 * Called by /api/fleet/audit/export. Produces a JSONL stream (newline-delimited
 * JSON objects) so large orgs can consume the response incrementally without
 * loading the entire result set into memory at once. The caller converts to CSV
 * using the canonical column order defined by AUDIT_CSV_COLUMNS.
 *
 * PRIVACY FLOOR — identical discipline to fleet-audit.ts:
 *   • Proposal summary hashes are SHA-256 of the proposal id only — never the
 *     text. The raw proposal text (a commit message / goal) is content, not
 *     metadata, and must never appear in an export.
 *   • All detail bags pass through sanitizeDetail() before serialisation.
 *   • Peer-share rules: export is gated to Pro+ orgs (map_enabled). Team orgs
 *     additionally get the org_id column stripped — it's implicit in the export
 *     context and leaking it cross-tenant would be a privacy risk.
 *
 * Column layout (AUDIT_CSV_COLUMNS — must stay stable across releases):
 *   timestamp, command_id, repo, agent_id, proposal_summary_hash, status,
 *   approval_wait_hours, cost_usd, applied_files_count, outcome
 *
 * Retention: 90 days — rows older than AUDIT_RETENTION_DAYS are deleted by
 * /api/cron/fleet-audit-retention on a daily schedule.
 */

import { createHash } from "crypto";
import { sql } from "./db";
import { sanitizeDetail } from "./fleet-audit";

// ---------------------------------------------------------------------------
// Column contract (must match the CSV header in the export route).
// ---------------------------------------------------------------------------

export const AUDIT_CSV_COLUMNS = [
  "timestamp",
  "command_id",
  "repo",
  "agent_id",
  "proposal_summary_hash",
  "status",
  "approval_wait_hours",
  "cost_usd",
  "applied_files_count",
  "outcome",
] as const;

export type AuditCsvColumn = (typeof AUDIT_CSV_COLUMNS)[number];

/** Retention window — keep 90 days, delete older. */
export const AUDIT_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface AuditExportQuery {
  /** ISO date string (inclusive). Defaults to 90 days ago. */
  since?: string | null;
  /** ISO date string (inclusive). Defaults to now. */
  until?: string | null;
  /** Filter to a single repo full_name. */
  repo?: string | null;
  /**
   * Batch size for the streaming cursor. Clamped to [100, 5000].
   * Default 1000. Larger values = fewer DB round-trips; smaller = lower
   * peak memory per batch. 1000 is a safe default for p99 org sizes.
   */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Raw row shape from the combined query
// ---------------------------------------------------------------------------

interface AuditExportRow {
  id: string;
  source: "fleet_event" | "fleet_command";
  ts: string;
  // fleet_event columns
  repo_name: string | null;
  fleet_owner: string | null;
  fleet_event: string | null;
  fleet_outcome: string | null;
  cost_millicents: number | bigint | string | null;
  session_id: string | null;
  // fleet_command columns
  kind: string | null;
  target: string | null;
  status: string | null;
  created_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | string | null;
}

// ---------------------------------------------------------------------------
// One normalised export row (matches AUDIT_CSV_COLUMNS)
// ---------------------------------------------------------------------------

export interface AuditExportRecord {
  timestamp: string;
  command_id: string;
  repo: string;
  agent_id: string;
  /**
   * SHA-256 of the command/event id — a stable opaque token that lets
   * compliance tooling track a proposal across export runs without ever
   * surfacing the actual proposal text (content floor).
   */
  proposal_summary_hash: string;
  status: string;
  /** Hours between claim and completion for fleet_command rows; 0 for events. */
  approval_wait_hours: number;
  /** Cost in USD, rounded to 6 decimal places. */
  cost_usd: number;
  /** Count of applied files from the result metadata, or 0. */
  applied_files_count: number;
  outcome: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function millicentsToUsd(v: number | bigint | string | null): number {
  if (v == null) return 0;
  const n =
    typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 100_000) * 1_000_000) / 1_000_000;
}

function proposalHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function approvalWaitHours(
  claimedAt: string | null,
  completedAt: string | null,
): number {
  if (!claimedAt || !completedAt) return 0;
  const diffMs =
    new Date(completedAt).getTime() - new Date(claimedAt).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.round((diffMs / 3_600_000) * 100) / 100;
}

function asObject(
  val: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (val == null) return {};
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return val;
}

function appliedFilesCount(result: Record<string, unknown> | string | null): number {
  const obj = sanitizeDetail(asObject(result));
  const v = obj.applied_files_count ?? obj.appliedFilesCount ?? obj.files_count;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return 0;
}

function mapRow(row: AuditExportRow): AuditExportRecord {
  if (row.source === "fleet_event") {
    return {
      timestamp: row.ts,
      command_id: row.id,
      repo: row.repo_name ?? "",
      agent_id: row.fleet_owner ?? row.session_id ?? "fleet",
      proposal_summary_hash: proposalHash(row.id),
      status: row.fleet_event ?? "event",
      approval_wait_hours: 0,
      cost_usd: millicentsToUsd(row.cost_millicents),
      applied_files_count: 0,
      outcome: row.fleet_outcome ?? "",
    };
  }

  // fleet_command row
  return {
    timestamp: row.ts,
    command_id: row.id,
    repo: row.target ?? "",
    agent_id: row.claimed_by ?? row.created_by ?? "system",
    proposal_summary_hash: proposalHash(row.id),
    status: row.kind ?? "command",
    approval_wait_hours: approvalWaitHours(row.claimed_at, row.completed_at),
    cost_usd: 0,
    applied_files_count: appliedFilesCount(row.result),
    outcome: row.status ?? "",
  };
}

// ---------------------------------------------------------------------------
// Streaming export — yields AuditExportRecord batches, newest first.
// ---------------------------------------------------------------------------

/**
 * Async generator that yields batches of AuditExportRecord for an org within
 * the given date range. Uses cursor-based pagination (offset) over the UNION
 * query so each batch is a fresh DB query — avoiding a single enormous result
 * set that would OOM on large fleets.
 *
 * The caller drives the generator:
 *   for await (const batch of streamAuditExport(orgId, query)) { ... }
 */
export async function* streamAuditExport(
  orgId: string,
  query: AuditExportQuery = {},
): AsyncGenerator<AuditExportRecord[]> {
  const db = sql();
  const batchSize = Math.min(5000, Math.max(100, query.batchSize ?? 1000));

  // Parse date bounds defensively.
  const now = new Date();
  const defaultSince = new Date(
    now.getTime() - AUDIT_RETENTION_DAYS * 24 * 3600_000,
  );

  let since: string = defaultSince.toISOString();
  if (query.since) {
    const d = new Date(query.since);
    if (!Number.isNaN(d.getTime())) since = d.toISOString();
  }

  let until: string = now.toISOString();
  if (query.until) {
    const d = new Date(query.until);
    if (!Number.isNaN(d.getTime())) until = d.toISOString();
  }

  const repo = query.repo ?? null;

  let offset = 0;

  for (;;) {
    // Each iteration fetches one batch. We fetch batchSize+1 to detect more
    // pages without a second COUNT query — if we got batchSize+1 rows there is
    // at least one more page; we only yield the first batchSize.
    const rows = await db.unsafe<AuditExportRow[]>(
      `
      WITH fleet_events AS (
        SELECT
          ae.id::text                                   AS id,
          'fleet_event'                                 AS source,
          ae.ts::text                                   AS ts,
          ae.repo_name                                  AS repo_name,
          ae.fleet_owner                                AS fleet_owner,
          ae.fleet_event                                AS fleet_event,
          ae.fleet_outcome                              AS fleet_outcome,
          ae.cost_millicents                            AS cost_millicents,
          ae.session_id                                 AS session_id,
          NULL::text                                    AS kind,
          NULL::text                                    AS target,
          ae.fleet_outcome                              AS status,
          NULL::text                                    AS created_by,
          NULL::text                                    AS claimed_by,
          NULL::text                                    AS claimed_at,
          NULL::text                                    AS completed_at,
          NULL::jsonb                                   AS result
        FROM activity_event ae
        JOIN membership m
          ON m.user_id::text = ae.user_id
         AND m.org_id = $1::uuid
        WHERE ae.source = 'ashlr-fleet'
          AND ae.fleet_event IN ('proposal', 'merge', 'decline')
          AND ae.ts >= $2::timestamptz
          AND ae.ts <= $3::timestamptz
          AND ($4::text IS NULL OR ae.repo_name = $4::text)
      ),
      fleet_commands AS (
        SELECT
          fc.id::text                                   AS id,
          'fleet_command'                               AS source,
          COALESCE(fc.completed_at, fc.claimed_at, fc.created_at)::text AS ts,
          NULL::text                                    AS repo_name,
          NULL::text                                    AS fleet_owner,
          NULL::text                                    AS fleet_event,
          NULL::text                                    AS fleet_outcome,
          NULL::bigint                                  AS cost_millicents,
          NULL::text                                    AS session_id,
          fc.kind                                       AS kind,
          fc.target                                     AS target,
          fc.status                                     AS status,
          fc.created_by::text                           AS created_by,
          fc.claimed_by                                 AS claimed_by,
          fc.claimed_at::text                           AS claimed_at,
          fc.completed_at::text                         AS completed_at,
          fc.result                                     AS result
        FROM fleet_command fc
        WHERE fc.org_id = $1::uuid
          AND COALESCE(fc.completed_at, fc.claimed_at, fc.created_at) >= $2::timestamptz
          AND COALESCE(fc.completed_at, fc.claimed_at, fc.created_at) <= $3::timestamptz
          AND ($4::text IS NULL OR fc.target = $4::text)
      )
      SELECT * FROM (
        SELECT * FROM fleet_events
        UNION ALL
        SELECT * FROM fleet_commands
      ) feed
      ORDER BY ts DESC, id DESC
      LIMIT $5 OFFSET $6
      `,
      [orgId, since, until, repo, batchSize + 1, offset],
    );

    const hasMore = rows.length > batchSize;
    const batch = hasMore ? rows.slice(0, batchSize) : rows;

    if (batch.length === 0) break;

    yield batch.map(mapRow);

    if (!hasMore) break;
    offset += batchSize;
  }
}

// ---------------------------------------------------------------------------
// CSV serialisation helpers (used by the export route)
// ---------------------------------------------------------------------------

/** Render the CSV header line. */
export function csvHeader(): string {
  return AUDIT_CSV_COLUMNS.join(",");
}

/** Escape a single value for RFC 4180 CSV. */
function csvCell(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Render one AuditExportRecord as a CSV data row (no trailing newline). */
export function csvRow(rec: AuditExportRecord): string {
  return AUDIT_CSV_COLUMNS.map((col) => csvCell(rec[col])).join(",");
}

// ---------------------------------------------------------------------------
// Retention delete (called by the cron route)
// ---------------------------------------------------------------------------

export interface RetentionResult {
  deletedEvents: number;
  deletedCommands: number;
}

/**
 * Delete fleet audit rows older than AUDIT_RETENTION_DAYS from both underlying
 * sources. Called by /api/cron/fleet-audit-retention.
 *
 * activity_event rows: we only prune WHERE source='ashlr-fleet' AND
 * fleet_event IN ('proposal','merge','decline') — we must not delete non-fleet
 * or non-lifecycle events that other features depend on.
 *
 * fleet_command rows: prune completed (done/failed) commands older than the
 * cutoff. Pending/claimed commands are never pruned — they may still be in
 * flight, and deleting them would orphan work.
 *
 * Returns the counts for the cron response body.
 */
export async function deleteOldAuditRows(): Promise<RetentionResult> {
  const db = sql();
  const cutoff = new Date(
    Date.now() - AUDIT_RETENTION_DAYS * 24 * 3600_000,
  ).toISOString();

  // activity_event: fleet lifecycle rows only.
  const evtResult = await db.unsafe<{ count: string }[]>(
    `
    DELETE FROM activity_event
    WHERE source = 'ashlr-fleet'
      AND fleet_event IN ('proposal', 'merge', 'decline')
      AND ts < $1::timestamptz
    RETURNING 1
    `,
    [cutoff],
  );

  // fleet_command: terminal states only (done/failed).
  const cmdResult = await db.unsafe<{ count: string }[]>(
    `
    DELETE FROM fleet_command
    WHERE status IN ('done', 'failed')
      AND COALESCE(completed_at, created_at) < $1::timestamptz
    RETURNING 1
    `,
    [cutoff],
  );

  return {
    deletedEvents: evtResult.length,
    deletedCommands: cmdResult.length,
  };
}
