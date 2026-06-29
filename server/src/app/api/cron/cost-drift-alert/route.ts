/**
 * POST /api/cron/cost-drift-alert — daily cost drift sweep (8am UTC).
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), same
 * pattern as /api/cron/digest and /api/cron/peer-share-refresh. Internal
 * endpoint; not user-facing.
 *
 * Per run:
 *   1. Load all orgs (via their primary-user memberships).
 *   2. For each org, fetch the last 28 days of activity_event aggregates.
 *   3. Run detectCostDrift — split into two 14-day windows.
 *   4. If anomalousShifts contains any shift > DRIFT_THRESHOLD_PCT (5%),
 *      email all org admins with the drift summary.
 *
 * Email is skipped (skipped: true) when SENDGRID_API_KEY / PULSE_DIGEST_FROM_EMAIL
 * are unset — safe for dev environments.
 *
 * Privacy: email body contains only aggregate cost totals + source/model enums.
 * No prompts, completions, code, repo names, or PII beyond the admin email.
 *
 * Idempotent: re-running the same day sends duplicate alerts (acceptable for
 * a cron that only fires once/day). The cron secret prevents accidental triggers.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { safeEqual } from "@/lib/timing-safe";
import { log } from "@/lib/logger";
import {
  detectCostDrift,
  splitWindows,
  totalCostMillicents,
  type DailyAggregate,
} from "@/lib/cost-drift-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes — scans all orgs

/** Number of days of history to fetch per org. */
const HISTORY_DAYS = 28;

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrgAdminRow {
  org_id: string;
  org_name: string;
  user_id: string;
  email: string;
}

interface PerOrgResult {
  org_id: string;
  org_name: string;
  status: "alerted" | "clean" | "skipped" | "error";
  anomalyCount?: number;
  detail?: string;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: cost-drift-alert starting" });

  const db = sql();

  // ── Load all org admins (owner role) ───────────────────────────────────────
  const admins = await db<OrgAdminRow[]>`
    SELECT
      o.id::text   AS org_id,
      o.name       AS org_name,
      u.id::text   AS user_id,
      u.email      AS email
    FROM org o
    JOIN membership m ON m.org_id = o.id
    JOIN "user"    u ON u.id       = m.user_id
    WHERE m.role = 'owner'
    ORDER BY o.created_at ASC
  `;

  // Group admins by org_id.
  const orgAdmins = new Map<string, OrgAdminRow[]>();
  for (const row of admins) {
    const arr = orgAdmins.get(row.org_id) ?? [];
    arr.push(row);
    orgAdmins.set(row.org_id, arr);
  }

  const results: PerOrgResult[] = [];

  for (const [orgId, adminRows] of orgAdmins) {
    const orgName = adminRows[0].org_name;
    try {
      // Fetch 28d aggregates for all users in this org.
      const aggRows = await db<{
        date: string;
        source: string;
        model: string;
        cost_millicents: string | number;
        event_count: string | number;
      }[]>`
        SELECT
          DATE(ae.ts AT TIME ZONE 'UTC')::text         AS date,
          COALESCE(ae.source, '')                      AS source,
          COALESCE(ae.model,  '')                      AS model,
          COALESCE(SUM(ae.cost_millicents), 0)::bigint AS cost_millicents,
          COUNT(*)::int                                AS event_count
        FROM activity_event ae
        JOIN membership m ON m.user_id = ae.user_id
        WHERE m.org_id  = ${orgId}::uuid
          AND ae.ts    >= NOW() - INTERVAL '${HISTORY_DAYS} days'
          AND ae.ts     < NOW()
        GROUP BY DATE(ae.ts AT TIME ZONE 'UTC'), ae.source, ae.model
        ORDER BY date ASC
      `;

      const aggregates: DailyAggregate[] = aggRows.map((r) => ({
        date:            r.date,
        source:          r.source,
        model:           r.model,
        cost_millicents: Number(r.cost_millicents ?? 0),
        event_count:     Number(r.event_count ?? 0),
      }));

      if (aggregates.length === 0) {
        results.push({ org_id: orgId, org_name: orgName, status: "clean", detail: "no activity" });
        continue;
      }

      const { prev14d, curr14d } = splitWindows(aggregates);
      const drift = detectCostDrift(prev14d, curr14d);

      if (drift.anomalousShifts.length === 0) {
        results.push({ org_id: orgId, org_name: orgName, status: "clean" });
        continue;
      }

      // ── Compose alert email ─────────────────────────────────────────────────
      const prevUsd = (totalCostMillicents(prev14d) / 100_000).toFixed(2);
      const currUsd = (totalCostMillicents(curr14d) / 100_000).toFixed(2);

      const shiftLines = drift.anomalousShifts
        .slice(0, 5)
        .map((a) => {
          const sign = a.pct >= 0 ? "+" : "";
          return `  • ${a.kind === "source" ? a.key : `model:${a.key}`}: ${sign}${a.pct.toFixed(1)}%`;
        })
        .join("\n");

      const subject = `[Pulse] Cost drift alert — ${orgName} (${drift.anomalousShifts.length} anomalies)`;
      const text = [
        `Ashlr Pulse detected cost drift for ${orgName}.`,
        "",
        `Period: last 14d vs prior 14d`,
        `  Prior window: $${prevUsd}`,
        `  Current window: $${currUsd}`,
        "",
        "Top anomalous shifts (>5% WoW):",
        shiftLines,
        "",
        drift.recommendation ? `Recommendation: ${drift.recommendation}` : "",
        "",
        "Review your spend breakdown at https://pulse.ashlr.dev/app?tab=costs",
        "",
        "— Ashlr Pulse",
        "You're receiving this because you're an org admin. Disable at /settings.",
      ].filter((l) => l !== undefined).join("\n");

      const html = `
        <div style="font-family:sans-serif;max-width:560px;color:#333">
          <h2 style="color:#c77;">⚠ Cost Drift Alert — ${escapeHtml(orgName)}</h2>
          <p>Ashlr Pulse detected spending anomalies for your org over the last 14 days
             compared to the prior 14-day window.</p>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:4px 8px;color:#666">Prior 14d:</td><td style="padding:4px 8px"><strong>$${prevUsd}</strong></td></tr>
            <tr><td style="padding:4px 8px;color:#666">Current 14d:</td><td style="padding:4px 8px"><strong>$${currUsd}</strong></td></tr>
          </table>
          <h3 style="margin-top:20px">Top Anomalous Shifts</h3>
          <ul style="padding-left:20px">
            ${drift.anomalousShifts
              .slice(0, 5)
              .map((a) => {
                const sign = a.pct >= 0 ? "+" : "";
                const color = a.pct > 0 ? "#c77" : "#7c7";
                return `<li><strong>${escapeHtml(a.kind === "source" ? a.key : `model: ${a.key}`)}</strong>
                  <span style="color:${color}">${sign}${a.pct.toFixed(1)}%</span></li>`;
              })
              .join("")}
          </ul>
          ${drift.recommendation
            ? `<h3>Recommendation</h3><p style="background:#f8f4e8;padding:10px 14px;border-radius:4px">${escapeHtml(drift.recommendation)}</p>`
            : ""}
          <p><a href="https://pulse.ashlr.dev/app?tab=costs" style="color:#5af">Review spend breakdown →</a></p>
          <p style="color:#999;font-size:12px">You're receiving this as an org admin. Manage alerts at /settings.</p>
        </div>
      `.trim();

      // Send to every admin in this org.
      let sentCount = 0;
      let skippedCount = 0;
      for (const admin of adminRows) {
        const r = await sendEmail({ to: admin.email, subject, html, text });
        if ("skipped" in r) {
          skippedCount++;
        } else if (r.ok) {
          sentCount++;
        }
        // Errors are swallowed per-admin — partial success is OK.
      }

      const status: PerOrgResult["status"] = sentCount > 0 ? "alerted" : skippedCount > 0 ? "skipped" : "alerted";
      results.push({
        org_id:        orgId,
        org_name:      orgName,
        status,
        anomalyCount:  drift.anomalousShifts.length,
        detail:        `sent=${sentCount} skipped=${skippedCount}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ msg: "cron: cost-drift-alert org threw", org_id: orgId, err: msg });
      results.push({ org_id: orgId, org_name: orgName, status: "error", detail: msg });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  const summary = {
    orgs:    orgAdmins.size,
    alerted: results.filter((r) => r.status === "alerted").length,
    clean:   results.filter((r) => r.status === "clean").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    error:   results.filter((r) => r.status === "error").length,
  };

  log.info({ msg: "cron: cost-drift-alert done", elapsed_ms, ...summary });

  // Per-org details (org_id, emails, drift values) go to the structured log
  // only — same privacy policy as /api/cron/digest.
  return NextResponse.json({ ok: true, elapsed_ms, ...summary });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
