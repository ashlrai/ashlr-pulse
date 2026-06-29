/**
 * GET /api/cost-attribution/export — CSV export of cost attribution by
 * source and model for the authenticated user.
 *
 * Auth: cookie session (currentUser). No plan gate — available to all plans
 * (the data is the user's own activity).
 *
 * Query params:
 *   since   — ISO-8601 lower bound (inclusive). Default: 30 days ago.
 *   until   — ISO-8601 upper bound (exclusive). Default: now.
 *   source  — optional source filter (e.g. "claude_code", "cursor").
 *
 * Response: text/csv attachment
 *   filename: cost-attribution-{since}-{until}.csv
 *
 * CSV columns:
 *   type | key | events | tokens | cost_usd | cost_share_pct
 *
 * Privacy floor: aggregated numbers only — no prompts, completions, or code.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, subscriptionSourcesFor } from "@/lib/org-db";
import { log, requestId } from "@/lib/logger";
import { loadCostAttributionBreakdown } from "@/lib/cost-attribution-breakdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── CSV column contract ───────────────────────────────────────────────────────
// Imported from the lib module — route files must only export HTTP handlers
// and a few allowed Next.js config fields (runtime, dynamic, maxDuration).
import { ATTRIBUTION_CSV_COLUMNS } from "@/lib/cost-attribution-breakdown";

// ── CSV helpers ───────────────────────────────────────────────────────────────

/** Escape a single value for RFC 4180 CSV. */
function csvCell(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: (string | number)[]): string {
  return values.map(csvCell).join(",");
}

function millicentsToUsd(cents: number | null): string {
  if (cents === null) return "";
  // cents is integer cents; convert to USD
  return (cents / 100).toFixed(6);
}

function sharePct(share: number): string {
  return (share * 100).toFixed(2);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const rid = requestId(req);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  // ── Parse + validate query params ────────────────────────────────────────
  const url = new URL(req.url);
  const sinceRaw  = url.searchParams.get("since");
  const untilRaw  = url.searchParams.get("until");
  const sourceRaw = url.searchParams.get("source");

  const sinceISO  = parseIsoOrNull(sinceRaw);
  const untilISO  = parseIsoOrNull(untilRaw);
  // Validate source against known enum values to prevent injection
  const sourceFilter = validateSource(sourceRaw);

  // ── Subscription sources ─────────────────────────────────────────────────
  const org = await primaryOrgForUser(me.id).catch(() => null);
  const subscriptionSources = org ? subscriptionSourcesFor(org) : new Set<string>();

  // ── Load attribution ──────────────────────────────────────────────────────
  let breakdown;
  try {
    breakdown = await loadCostAttributionBreakdown({
      userId:             me.id,
      sinceISO,
      untilISO,
      subscriptionSources,
      sourceFilter,
    });
  } catch (err) {
    log.error({ rid, err }, "cost-attribution/export: load failed");
    return NextResponse.json(
      { error: "failed to load attribution data" },
      { status: 500, headers: { "x-request-id": rid } },
    );
  }

  // ── Build CSV ─────────────────────────────────────────────────────────────
  const lines: string[] = [];

  // Header
  lines.push(csvRow([...ATTRIBUTION_CSV_COLUMNS]));

  // Source rows
  for (const r of breakdown.bySource) {
    lines.push(
      csvRow([
        "source",
        r.source,
        r.events,
        r.tokens,
        millicentsToUsd(r.cost_cents),
        sharePct(r.cost_share),
      ]),
    );
  }

  // Model rows
  for (const r of breakdown.byModel) {
    lines.push(
      csvRow([
        "model",
        r.model,
        r.events,
        r.tokens,
        millicentsToUsd(r.cost_cents),
        sharePct(r.cost_share),
      ]),
    );
  }

  const csv = lines.join("\n") + "\n";

  // Derive a friendly filename from the actual data range
  const since = breakdown.since ?? sinceISO?.slice(0, 10) ?? "all";
  const until = breakdown.until ?? untilISO?.slice(0, 10) ?? "now";
  const filename = `cost-attribution-${since}-${until}.csv`;

  log.info({ rid, userId: me.id, rows: lines.length - 1 }, "cost-attribution/export: ok");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "x-request-id":        rid,
      "Cache-Control":       "no-store",
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIsoOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Sanity range: 2020-01-01 to 2099-12-31
  const year = d.getUTCFullYear();
  if (year < 2020 || year > 2099) return null;
  return d.toISOString();
}

/** Known source values from the activity_event schema. */
const KNOWN_SOURCES = new Set([
  "claude_code", "cursor", "copilot", "wakatime", "shell",
  "git", "ashlr_plugin", "codex", "ashlr-fleet",
]);

function validateSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return KNOWN_SOURCES.has(raw) ? raw : null;
}
