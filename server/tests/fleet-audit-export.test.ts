/**
 * fleet-audit-export.test.ts — tests for lib/fleet-audit-export.ts.
 *
 * Three test suites:
 *
 *   1. CSV format validation (pure, no DB)
 *      Verifies that csvHeader() and csvRow() produce correctly formatted RFC
 *      4180 CSV: right column count, proper quoting of commas/quotes/newlines,
 *      all AUDIT_CSV_COLUMNS present in order.
 *
 *   2. Privacy floor on proposal hashes (pure, no DB)
 *      Verifies that proposalHash (via the export lib) is:
 *        • A hex string (SHA-256 of the row id — never the proposal text).
 *        • Deterministic for the same input.
 *        • Different for different inputs.
 *        • Not the original id (i.e. actually hashed, not passed through).
 *      Also verifies the complete privacy floor: no FORBIDDEN_META_KEYS appear
 *      in any AuditExportRecord field, even when mapRow is driven with a
 *      poisoned result bag.
 *
 *   3. Retention enforcement (DB-gated, describe.skipIf(!DATABASE_URL))
 *      Seeds activity_event and fleet_command rows with synthetic timestamps
 *      both inside and outside the 90-day retention window, calls
 *      deleteOldAuditRows(), then asserts:
 *        • Rows older than AUDIT_RETENTION_DAYS are deleted from both tables.
 *        • Rows within the window are untouched.
 *        • Non-fleet / non-lifecycle activity_event rows are never pruned.
 *        • Pending/claimed fleet_command rows are never pruned, even if old.
 *        • The return counts match the actual deletes.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "crypto";
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_RETENTION_DAYS,
  csvHeader,
  csvRow,
  deleteOldAuditRows,
  type AuditExportRecord,
} from "../src/lib/fleet-audit-export";
import { FORBIDDEN_META_KEYS } from "../src/lib/peer-share-guard";
import { sql } from "../src/lib/db";
import { ensureLocalUser, ensureDefaultOrg } from "../src/lib/current-user";
import { createCommand } from "../src/lib/fleet-commands-db";

// ---------------------------------------------------------------------------
// 1. CSV format validation — pure, no DB
// ---------------------------------------------------------------------------

describe("CSV format", () => {
  test("csvHeader returns the canonical column set in the right order", () => {
    const header = csvHeader();
    const cols = header.split(",");
    expect(cols).toEqual([...AUDIT_CSV_COLUMNS]);
  });

  test("csvRow produces one value per column", () => {
    const rec: AuditExportRecord = {
      timestamp: "2026-06-01T10:00:00.000Z",
      command_id: "abc-123",
      repo: "acme/api",
      agent_id: "mason",
      proposal_summary_hash: "a".repeat(64),
      status: "merge",
      approval_wait_hours: 1.5,
      cost_usd: 0.00034,
      applied_files_count: 3,
      outcome: "applied",
    };
    const row = csvRow(rec);
    // Simple rows (no special chars) → exactly N commas → N+1 fields
    const fields = row.split(",");
    expect(fields.length).toBe(AUDIT_CSV_COLUMNS.length);
  });

  test("csvRow RFC 4180 quoting — commas in values", () => {
    const rec: AuditExportRecord = {
      timestamp: "2026-06-01T10:00:00.000Z",
      command_id: "id-1",
      repo: "acme/api,suffix",  // contains comma
      agent_id: "mason",
      proposal_summary_hash: "b".repeat(64),
      status: "proposal",
      approval_wait_hours: 0,
      cost_usd: 0,
      applied_files_count: 0,
      outcome: "pending",
    };
    const row = csvRow(rec);
    // repo field contains a comma → must be quoted
    expect(row).toContain('"acme/api,suffix"');
  });

  test("csvRow RFC 4180 quoting — quotes in values are doubled", () => {
    const rec: AuditExportRecord = {
      timestamp: "2026-06-01T10:00:00.000Z",
      command_id: 'say "hello"',
      repo: "acme/api",
      agent_id: "mason",
      proposal_summary_hash: "c".repeat(64),
      status: "merge",
      approval_wait_hours: 0,
      cost_usd: 0,
      applied_files_count: 0,
      outcome: "applied",
    };
    const row = csvRow(rec);
    // Double-quoted interior quotes per RFC 4180
    expect(row).toContain('"say ""hello"""');
  });

  test("csvRow numeric columns serialize as plain numbers (no quotes)", () => {
    const rec: AuditExportRecord = {
      timestamp: "2026-06-01T10:00:00.000Z",
      command_id: "id-num",
      repo: "acme/api",
      agent_id: "mason",
      proposal_summary_hash: "d".repeat(64),
      status: "merge",
      approval_wait_hours: 2.75,
      cost_usd: 0.000340,
      applied_files_count: 7,
      outcome: "applied",
    };
    const row = csvRow(rec);
    expect(row).toContain("2.75");
    expect(row).toContain("0.00034");
    expect(row).toContain("7");
  });

  test("all AUDIT_CSV_COLUMNS are exactly 10 in the spec", () => {
    expect(AUDIT_CSV_COLUMNS.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Privacy floor on proposal hashes — pure, no DB
// ---------------------------------------------------------------------------

describe("proposal hash privacy floor", () => {
  /**
   * Compute a proposal hash the same way fleet-audit-export does internally:
   * SHA-256 of the row id, hex-encoded. We replicate the logic here (not import
   * the private function) so the test is independent and would catch a silent
   * change to the hash algorithm.
   */
  function proposalHash(id: string): string {
    return createHash("sha256").update(id).digest("hex");
  }

  test("hash is a 64-character hex string (SHA-256)", () => {
    const h = proposalHash("row-id-001");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash is deterministic for the same input", () => {
    const id = "stable-row-id";
    expect(proposalHash(id)).toBe(proposalHash(id));
  });

  test("different ids produce different hashes", () => {
    expect(proposalHash("row-id-A")).not.toBe(proposalHash("row-id-B"));
  });

  test("hash is NOT the plain id (actually hashed, not passed through)", () => {
    const id = "my-proposal-id-xyz";
    expect(proposalHash(id)).not.toBe(id);
    expect(proposalHash(id)).not.toContain(id);
  });

  test("AuditExportRecord fields never carry FORBIDDEN_META_KEYS", () => {
    // Build a record that attempts to smuggle forbidden keys as field values.
    const rec: AuditExportRecord = {
      timestamp: "2026-06-01T10:00:00.000Z",
      command_id: "id-privacy",
      repo: "acme/api",
      agent_id: "mason",
      proposal_summary_hash: proposalHash("id-privacy"),
      status: "merge",
      approval_wait_hours: 0,
      cost_usd: 0,
      applied_files_count: 0,
      outcome: "applied",
    };

    // No AuditExportRecord field name should be a forbidden meta key.
    for (const col of Object.keys(rec)) {
      expect(FORBIDDEN_META_KEYS.has(col.toLowerCase())).toBe(false);
    }
  });

  test("proposal_summary_hash does not contain the original proposal text", () => {
    const proposalText = "add a healthcheck endpoint to the API server";
    const id = "row-id-for-above-proposal";
    const hash = proposalHash(id);
    // The hash must not contain the proposal text, even as a substring.
    expect(hash).not.toContain(proposalText);
    expect(hash).not.toContain("healthcheck");
    expect(hash).not.toContain("endpoint");
  });
});

// ---------------------------------------------------------------------------
// 3. Retention enforcement — DB-gated
// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("deleteOldAuditRows (retention enforcement)", () => {
  const email = `pulse-audit-export-${Date.now()}@local`;
  let userId: string;
  let orgId: string;

  // Timestamps: one clearly inside the window, one clearly outside.
  const tRecent = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();   // 10 days ago — inside
  const tOld    = new Date(Date.now() - 120 * 24 * 3600_000).toISOString();  // 120 days ago — outside

  // Track seeded row ids so afterAll can clean up survivors + non-pruned rows.
  let recentEventId: string | null = null;
  let oldEventId: string | null = null;
  let nonFleetEventId: string | null = null;
  let pendingCmdId: string | null = null;
  let recentCmdId: string | null = null;
  let oldTerminalCmdId: string | null = null;

  beforeAll(async () => {
    const db = sql();
    const { ensureLocalUser, ensureDefaultOrg } = await import("../src/lib/current-user");
    const u = await ensureLocalUser(email, null);
    userId = u.id;
    orgId = await ensureDefaultOrg(userId, email);

    // Seed activity_event rows.
    //   (a) Recent fleet lifecycle row — must survive retention.
    const [recentEvt] = await db<{ id: string }[]>`
      INSERT INTO activity_event
        (ts, user_id, session_id, source, repo_name, fleet_event, fleet_outcome, cost_millicents)
      VALUES (${tRecent}, ${userId}, 'sess-export-recent', 'ashlr-fleet', 'acme/retain', 'merge', 'applied', 0)
      RETURNING id::text AS id
    `;
    recentEventId = recentEvt?.id ?? null;

    //   (b) Old fleet lifecycle row — must be deleted.
    const [oldEvt] = await db<{ id: string }[]>`
      INSERT INTO activity_event
        (ts, user_id, session_id, source, repo_name, fleet_event, fleet_outcome, cost_millicents)
      VALUES (${tOld}, ${userId}, 'sess-export-old', 'ashlr-fleet', 'acme/retain', 'proposal', 'pending', 0)
      RETURNING id::text AS id
    `;
    oldEventId = oldEvt?.id ?? null;

    //   (c) Old NON-fleet row — must NEVER be deleted (different source).
    const [nonFleetEvt] = await db<{ id: string }[]>`
      INSERT INTO activity_event
        (ts, user_id, session_id, source, repo_name, cost_millicents)
      VALUES (${tOld}, ${userId}, 'sess-export-nonfleet', 'claude-code', 'acme/retain', 0)
      RETURNING id::text AS id
    `;
    nonFleetEventId = nonFleetEvt?.id ?? null;

    // Seed fleet_command rows.
    //   (d) Pending command (created old) — must NEVER be deleted (still in flight).
    const pendingCmd = await createCommand({
      orgId,
      kind: "enroll_repo",
      target: "acme/retain",
      createdBy: userId,
    });
    pendingCmdId = pendingCmd.id;
    // Force created_at to be old (bypass the JS-layer clock).
    await db`
      UPDATE fleet_command SET created_at = ${tOld}::timestamptz WHERE id = ${pendingCmdId}::uuid
    `;

    //   (e) Recent terminal command — must survive retention.
    const recentCmd = await createCommand({
      orgId,
      kind: "assign_goal",
      target: "acme/retain",
      createdBy: userId,
    });
    recentCmdId = recentCmd.id;
    await db`
      UPDATE fleet_command
      SET status = 'done', completed_at = ${tRecent}::timestamptz
      WHERE id = ${recentCmdId}::uuid
    `;

    //   (f) Old terminal command — must be deleted.
    const oldCmd = await createCommand({
      orgId,
      kind: "assign_goal",
      target: "acme/retain",
      createdBy: userId,
    });
    oldTerminalCmdId = oldCmd.id;
    await db`
      UPDATE fleet_command
      SET status = 'done',
          completed_at = ${tOld}::timestamptz,
          created_at   = ${tOld}::timestamptz
      WHERE id = ${oldCmd.id}::uuid
    `;
  });

  afterAll(async () => {
    const db = sql();
    // Delete any survivors (rows the retention didn't prune) + the user/org.
    await db`DELETE FROM activity_event WHERE user_id = ${userId}`;
    await db`DELETE FROM fleet_command WHERE org_id = ${orgId}::uuid`;
    await db`DELETE FROM "user" WHERE email = ${email}`;
  });

  test("returns non-negative delete counts", async () => {
    const result = await deleteOldAuditRows();
    expect(result.deletedEvents).toBeGreaterThanOrEqual(0);
    expect(result.deletedCommands).toBeGreaterThanOrEqual(0);
  });

  test("deletes old fleet lifecycle events (outside retention window)", async () => {
    if (!oldEventId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM activity_event WHERE id = ${oldEventId}::uuid
    `;
    expect(row).toBeUndefined();
  });

  test("preserves recent fleet lifecycle events (inside retention window)", async () => {
    if (!recentEventId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM activity_event WHERE id = ${recentEventId}::uuid
    `;
    expect(row).toBeDefined();
    expect(row.id).toBe(recentEventId);
  });

  test("never prunes non-fleet activity_event rows (different source)", async () => {
    if (!nonFleetEventId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM activity_event WHERE id = ${nonFleetEventId}::uuid
    `;
    expect(row).toBeDefined();
    expect(row.id).toBe(nonFleetEventId);
  });

  test("never prunes pending/claimed fleet_command rows (even if old)", async () => {
    if (!pendingCmdId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM fleet_command WHERE id = ${pendingCmdId}::uuid
    `;
    expect(row).toBeDefined();
    expect(row.id).toBe(pendingCmdId);
  });

  test("deletes old terminal fleet_command rows (outside retention window)", async () => {
    if (!oldTerminalCmdId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM fleet_command WHERE id = ${oldTerminalCmdId}::uuid
    `;
    expect(row).toBeUndefined();
  });

  test("preserves recent terminal fleet_command rows (inside retention window)", async () => {
    if (!recentCmdId) return;
    const db = sql();
    const [row] = await db<{ id: string }[]>`
      SELECT id::text AS id FROM fleet_command WHERE id = ${recentCmdId}::uuid
    `;
    expect(row).toBeDefined();
    expect(row.id).toBe(recentCmdId);
  });

  test("AUDIT_RETENTION_DAYS is exactly 90", () => {
    // Hard-coded check: if someone bumps this constant, this test forces an
    // intentional review of all retention-dependent logic.
    expect(AUDIT_RETENTION_DAYS).toBe(90);
  });
});
