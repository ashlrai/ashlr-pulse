/**
 * fleet-commands-db.ts — CRUD over the fleet_command queue (migration 0028).
 *
 * The Map control plane, cloud side. The Map / Radar UI ENQUEUES intent here
 * (createCommand); the local ashlr-hub daemon POLLS (listPending), CLAIMS the
 * oldest pending row (claimNext), executes the work locally, and reports the
 * outcome (complete / fail). The cloud never calls the fleet — it is strictly
 * pull-only and no-inbound; this table is the entire bridge.
 *
 * Everything is ORG-SCOPED: a daemon authenticated for org A can never see or
 * mutate org B's commands. Every transition takes an orgId and filters on it.
 *
 * PRIVACY FLOOR: `payload` and `result` are STRUCTURED METADATA ONLY — ids,
 * repo full_names, goal text the user typed, an opened-PR url. They are run
 * through assertMetadataOnly() before they ever reach Postgres, so a bug in a
 * caller can never smuggle code / prompts / diffs into a cloud-stored field.
 */

import { sql } from "./db";
import { assertMetadataOnly } from "./peer-share-guard";
import {
  type FleetCommand,
  type FleetCommandKind,
  FLEET_COMMAND_KINDS,
} from "./graph-types";

// ---------------------------------------------------------------------------
// Row → FleetCommand mapping
// ---------------------------------------------------------------------------

interface FleetCommandRow {
  id: string;
  org_id: string;
  kind: FleetCommandKind;
  target: string | null;
  // jsonb columns can surface as an object or as raw JSON text depending on the
  // query path; asJsonObject() normalizes both.
  payload: Record<string, unknown> | string | null;
  status: FleetCommand["status"];
  created_by: string | null;
  claimed_by: string | null;
  result: Record<string, unknown> | string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

/**
 * Coerce a jsonb column to a plain object. Depending on the driver/path, a
 * jsonb value can come back already-parsed (object) or as raw JSON text — the
 * INSERT…RETURNING and SELECT paths here both surface `payload`/`result` as a
 * string. Normalize so callers (the daemon, the Map UI) always receive the
 * object the FleetCommand contract promises, never a string.
 */
function asJsonObject(
  val: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (val == null) return null;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return val;
}

function mapRow(row: FleetCommandRow): FleetCommand {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    target: row.target,
    payload: asJsonObject(row.payload) ?? {},
    status: row.status,
    createdBy: row.created_by,
    claimedBy: row.claimed_by,
    result: asJsonObject(row.result),
    error: row.error,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

// The full column projection, reused by every query as a postgres-js
// fragment so the row→FleetCommand mapping has every field it needs.
function rowColumns(db: ReturnType<typeof sql>) {
  return db`
    id::text AS id, org_id::text AS org_id, kind, target, payload, status,
    created_by::text AS created_by, claimed_by, result, error,
    created_at, claimed_at, completed_at
  `;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Narrow an arbitrary string to a known FleetCommandKind, or throw. */
export function assertCommandKind(kind: string): FleetCommandKind {
  if (!FLEET_COMMAND_KINDS.includes(kind as FleetCommandKind)) {
    throw new Error(`unknown fleet command kind: ${kind}`);
  }
  return kind as FleetCommandKind;
}

// ---------------------------------------------------------------------------
// Create (Map / Radar enqueue)
// ---------------------------------------------------------------------------

export interface CreateCommandInput {
  orgId: string;
  kind: FleetCommandKind;
  target?: string | null;
  payload?: Record<string, unknown>;
  /** local user.id of the person who triggered this (nullable). */
  createdBy?: string | null;
}

/**
 * Enqueue a pending command for an org. `payload` is metadata-only and is
 * validated against the privacy floor before insert.
 */
export async function createCommand(
  input: CreateCommandInput,
): Promise<FleetCommand> {
  const kind = assertCommandKind(input.kind);
  const payload = assertMetadataOnly(input.payload ?? {}, "fleet_command.payload");
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    INSERT INTO fleet_command (org_id, kind, target, payload, created_by)
    VALUES (
      ${input.orgId}::uuid,
      ${kind},
      ${input.target ?? null},
      ${JSON.stringify(payload)}::jsonb,
      ${input.createdBy ?? null}
    )
    RETURNING ${rowColumns(db)}
  `;
  return mapRow(row);
}

// ---------------------------------------------------------------------------
// Read (daemon poll + UI list)
// ---------------------------------------------------------------------------

/**
 * Pending commands for an org, oldest first — the daemon's poll. Uses the
 * partial fleet_command_poll_idx hot path.
 */
export async function listPending(
  orgId: string,
  limit = 50,
): Promise<FleetCommand[]> {
  const db = sql();
  const rows = await db<FleetCommandRow[]>`
    SELECT ${rowColumns(db)}
    FROM fleet_command
    WHERE org_id = ${orgId}::uuid
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

/** A single command, org-scoped (returns null if not in this org). */
export async function getCommand(
  orgId: string,
  id: string,
): Promise<FleetCommand | null> {
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    SELECT ${rowColumns(db)}
    FROM fleet_command
    WHERE id = ${id}::uuid
      AND org_id = ${orgId}::uuid
    LIMIT 1
  `;
  return row ? mapRow(row) : null;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (daemon)
// ---------------------------------------------------------------------------

/**
 * Atomically claim the oldest pending command for an org and stamp it with the
 * claiming machine id. Uses FOR UPDATE SKIP LOCKED so concurrent daemons in
 * the same org never claim the same row. Returns null when the queue is empty.
 */
export async function claimNext(
  orgId: string,
  machineId: string,
): Promise<FleetCommand | null> {
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    UPDATE fleet_command
    SET status = 'claimed',
        claimed_by = ${machineId},
        claimed_at = NOW()
    WHERE id = (
      SELECT id FROM fleet_command
      WHERE org_id = ${orgId}::uuid
        AND status = 'pending'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${rowColumns(db)}
  `;
  return row ? mapRow(row) : null;
}

/**
 * Claim a SPECIFIC pending command by id (org-scoped). Returns null if the row
 * isn't pending, isn't in this org, or was already claimed by someone else.
 */
export async function claimById(
  orgId: string,
  id: string,
  machineId: string,
): Promise<FleetCommand | null> {
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    UPDATE fleet_command
    SET status = 'claimed',
        claimed_by = ${machineId},
        claimed_at = NOW()
    WHERE id = ${id}::uuid
      AND org_id = ${orgId}::uuid
      AND status = 'pending'
    RETURNING ${rowColumns(db)}
  `;
  return row ? mapRow(row) : null;
}

/**
 * Mark a claimed command done with a metadata-only result. Org-scoped; only a
 * 'claimed' row transitions (idempotent re-completes are rejected). Returns
 * null if no eligible row matched.
 */
export async function complete(
  orgId: string,
  id: string,
  result: Record<string, unknown> = {},
): Promise<FleetCommand | null> {
  const safeResult = assertMetadataOnly(result, "fleet_command.result");
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    UPDATE fleet_command
    SET status = 'done',
        result = ${JSON.stringify(safeResult)}::jsonb,
        completed_at = NOW()
    WHERE id = ${id}::uuid
      AND org_id = ${orgId}::uuid
      AND status = 'claimed'
    RETURNING ${rowColumns(db)}
  `;
  return row ? mapRow(row) : null;
}

/**
 * Mark a claimed command failed with a short error string. Org-scoped; only a
 * 'claimed' row transitions. Returns null if no eligible row matched.
 */
export async function fail(
  orgId: string,
  id: string,
  error: string,
): Promise<FleetCommand | null> {
  // Cap the error string so a stack-dump / file body can't slip through.
  const safeError = error.slice(0, 2000);
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    UPDATE fleet_command
    SET status = 'failed',
        error = ${safeError},
        completed_at = NOW()
    WHERE id = ${id}::uuid
      AND org_id = ${orgId}::uuid
      AND status = 'claimed'
    RETURNING ${rowColumns(db)}
  `;
  return row ? mapRow(row) : null;
}

// ---------------------------------------------------------------------------
// Proposal listing (drill-down surface)
// ---------------------------------------------------------------------------

/**
 * List fleet commands that are proposal-related (approve_proposal /
 * reject_proposal), newest first, for the proposal drill-down index.
 * Org-scoped. Limit clamped to 200.
 */
export async function listProposals(
  orgId: string,
  limit = 50,
): Promise<FleetCommand[]> {
  const safeLimit = Math.min(200, Math.max(1, limit));
  const db = sql();
  const rows = await db<FleetCommandRow[]>`
    SELECT ${rowColumns(db)}
    FROM fleet_command
    WHERE org_id = ${orgId}::uuid
      AND kind IN ('approve_proposal', 'reject_proposal')
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
  return rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Inbox views (human operator) — newest-first listing + status counts.
// Backs /fleet (the Fleet inbox page) via the fleet-inbox-db re-export.
// ---------------------------------------------------------------------------

/**
 * All commands for an org, newest first — the operator inbox. Unlike
 * listPending (the daemon's oldest-first poll), this surfaces every lifecycle
 * state so a human can watch the queue drain. Limit clamped to [1, 500].
 */
export async function listForOrg(
  orgId: string,
  limit = 100,
): Promise<FleetCommand[]> {
  const safeLimit = Math.min(500, Math.max(1, limit));
  const db = sql();
  const rows = await db<FleetCommandRow[]>`
    SELECT ${rowColumns(db)}
    FROM fleet_command
    WHERE org_id = ${orgId}::uuid
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
  return rows.map(mapRow);
}

/**
 * Cancel a still-PENDING command before the daemon claims it. Transitions
 * pending → failed with error="cancelled by operator". The `status = 'pending'`
 * guard makes this race-safe against claimNext(): if a daemon claims the row
 * first, this no-ops and returns null, and the operator sees it move to
 * "claimed" on the next poll. Returns the updated command, or null if it was
 * not found in this org / no longer pending.
 */
export async function cancelPending(
  orgId: string,
  id: string,
): Promise<FleetCommand | null> {
  const db = sql();
  const [row] = await db<FleetCommandRow[]>`
    UPDATE fleet_command
    SET status = 'failed',
        error = 'cancelled by operator',
        completed_at = NOW()
    WHERE id = ${id}::uuid
      AND org_id = ${orgId}::uuid
      AND status = 'pending'
    RETURNING ${rowColumns(db)}
  `;
  return row ? mapRow(row) : null;
}

/** Per-status row counts for an org — the inbox header badges. */
export interface StatusCounts {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
}

/**
 * Count commands grouped by lifecycle status for an org. Missing statuses
 * come back as 0 so the inbox header always renders a complete set of badges.
 */
export async function countsByStatus(orgId: string): Promise<StatusCounts> {
  const db = sql();
  const rows = await db<{ status: string; n: string }[]>`
    SELECT status, COUNT(*)::text AS n
    FROM fleet_command
    WHERE org_id = ${orgId}::uuid
    GROUP BY status
  `;
  const counts: StatusCounts = { pending: 0, claimed: 0, done: 0, failed: 0 };
  for (const r of rows) {
    if (r.status in counts) {
      counts[r.status as keyof StatusCounts] = Number(r.n) || 0;
    }
  }
  return counts;
}
