/**
 * GET  /api/settings/anomalies — load user preferences + org calibration settings.
 * POST /api/settings/anomalies — upsert user preferences and/or org calibration settings.
 *
 * GET response shape:
 *   {
 *     preferences:   Record<AnomalyKind, AnomalyPreference>,
 *     org_settings:  AnomalySettings
 *   }
 *
 * POST body (all fields optional — include only what you want to change):
 *   {
 *     // Per-user per-kind toggles + severity threshold multipliers
 *     preferences?: {
 *       [kind: AnomalyKind]: {
 *         enabled?: boolean,
 *         severity_low_threshold?: number,   // 0.1 – 10.0
 *         severity_high_threshold?: number   // 0.1 – 10.0
 *       }
 *     },
 *     // Org-level calibration (any org member may write)
 *     org_settings?: {
 *       sensitivity_level?:       'conservative' | 'moderate' | 'aggressive',
 *       threshold_overrides?:     { cost_spike?: number, velocity_drop?: number },
 *       enabled_detector_types?:  AnomalyKind[]
 *     },
 *     // Simulation: recompute last 7d anomalies with proposed org_settings
 *     simulate?: true
 *   }
 *
 * POST response:
 *   {
 *     preferences:  Record<AnomalyKind, AnomalyPreference>,
 *     org_settings: AnomalySettings,
 *     simulation?:  {
 *       proposed_count:  number,   // alerts that would have fired
 *       current_count:   number,   // alerts under current settings
 *       proposed_by_severity: Record<'high'|'medium'|'low', number>,
 *       current_by_severity:  Record<'high'|'medium'|'low', number>,
 *       summary: string            // "3 alerts (vs 5 currently)"
 *     }
 *   }
 *
 * Auth: Supabase session via currentUser(). 401 if missing.
 * Validation: zod. 400 on schema violations.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import {
  getEffectivePreferences,
  upsertPreferences,
  ANOMALY_KINDS,
  type AnomalyPreference,
  type AnomalyPreferenceMap,
} from "@/lib/anomaly-preference-db";
import {
  getOrgAnomalySettings,
  upsertOrgAnomalySettings,
} from "@/lib/org-anomaly-settings-db";
import {
  deriveAnomaliesWithSettings,
  DEFAULT_ANOMALY_SETTINGS,
  type AnomalySettings,
  type AnomalyKind,
  type AnomalyContext,
} from "@/lib/realtime-anomaly";
import type { FleetRealtimeEvent } from "@/lib/fleet-realtime";
import { sql } from "@/lib/db";

// Suppress unused-import warning — ANOMALY_KINDS is used by the zod schema
// through the AnomalyKindEnum literal list (kept in sync manually).
void ANOMALY_KINDS;

// ---------------------------------------------------------------------------
// Org resolution helper
// ---------------------------------------------------------------------------

async function resolveOrgId(userId: string): Promise<string | null> {
  const db = sql();
  const rows = await db<{ org_id: string }[]>`
    SELECT org_id::text AS org_id FROM membership WHERE user_id = ${userId}::uuid LIMIT 1
  `;
  return rows[0]?.org_id ?? null;
}

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ThresholdValue = z.number().min(0.1).max(10.0);

const SinglePrefSchema = z.object({
  enabled:                 z.boolean().optional(),
  severity_low_threshold:  ThresholdValue.optional(),
  severity_high_threshold: ThresholdValue.optional(),
});

const AnomalyKindEnum = z.enum([
  "cost_spike",
  "token_explosion",
  "tool_failure_rate",
  "model_thrash",
  "cache_miss_storm",
  "peer_divergence",
]);

const OrgSettingsSchema = z.object({
  sensitivity_level: z.enum(["conservative", "moderate", "aggressive"]).optional(),
  threshold_overrides: z.object({
    cost_spike:    z.number().min(0).optional(),
    velocity_drop: z.number().min(0).max(100).optional(),
  }).optional(),
  enabled_detector_types: z.array(AnomalyKindEnum).optional(),
});

const PostBodySchema = z.object({
  preferences:  z.record(AnomalyKindEnum, SinglePrefSchema).optional(),
  org_settings: OrgSettingsSchema.optional(),
  simulate:     z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const orgId = await resolveOrgId(me.id);

  const [preferences, org_settings] = await Promise.all([
    getEffectivePreferences(me.id),
    orgId ? getOrgAnomalySettings(orgId) : Promise.resolve({ ...DEFAULT_ANOMALY_SETTINGS }),
  ]);

  return NextResponse.json({ preferences, org_settings });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation error", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { preferences: prefPatch, org_settings: orgPatch, simulate } = parsed.data;
  const orgId = await resolveOrgId(me.id);

  // ── 1. Update per-user preferences ────────────────────────────────────────
  if (prefPatch && Object.keys(prefPatch).length > 0) {
    const current = await getEffectivePreferences(me.id);
    const updates: Partial<AnomalyPreferenceMap> = {};
    for (const [rawKind, patch] of Object.entries(prefPatch)) {
      const kind = rawKind as AnomalyKind;
      const existing: AnomalyPreference = current[kind];
      updates[kind] = {
        kind,
        enabled:                 patch.enabled                 ?? existing.enabled,
        severity_low_threshold:  patch.severity_low_threshold  ?? existing.severity_low_threshold,
        severity_high_threshold: patch.severity_high_threshold ?? existing.severity_high_threshold,
      };
    }
    await upsertPreferences(me.id, updates);
  }

  // ── 2. Update org-level calibration settings ──────────────────────────────
  let proposedSettings: AnomalySettings | null = null;
  if (orgPatch && orgId) {
    const currentOrgSettings = await getOrgAnomalySettings(orgId);
    proposedSettings = {
      sensitivity_level: orgPatch.sensitivity_level ?? currentOrgSettings.sensitivity_level,
      threshold_overrides: {
        ...currentOrgSettings.threshold_overrides,
        ...(orgPatch.threshold_overrides ?? {}),
      },
      enabled_detector_types:
        orgPatch.enabled_detector_types != null
          ? (orgPatch.enabled_detector_types as AnomalyKind[])
          : currentOrgSettings.enabled_detector_types,
    };
    await upsertOrgAnomalySettings(orgId, proposedSettings);
  }

  // ── 3. Simulation (optional) ──────────────────────────────────────────────
  let simulation: SimulationResult | undefined;
  if (simulate && orgId) {
    const effectiveProposed = proposedSettings
      ?? await getOrgAnomalySettings(orgId);
    simulation = await runSimulation(orgId, effectiveProposed);
  }

  // ── 4. Return updated state ───────────────────────────────────────────────
  const [preferences, org_settings] = await Promise.all([
    getEffectivePreferences(me.id),
    orgId ? getOrgAnomalySettings(orgId) : Promise.resolve({ ...DEFAULT_ANOMALY_SETTINGS }),
  ]);

  return NextResponse.json({ preferences, org_settings, simulation });
}

// ---------------------------------------------------------------------------
// Simulation helper
// ---------------------------------------------------------------------------

interface SimulationResult {
  proposed_count:       number;
  current_count:        number;
  proposed_by_severity: Record<"high" | "medium" | "low", number>;
  current_by_severity:  Record<"high" | "medium" | "low", number>;
  summary:              string;
}

interface FleetEventRow {
  ts: string;
  source: string;
  fleet_event: string | null;
  fleet_outcome: string | null;
  fleet_owner: string | null;
  repo_name: string | null;
  provider: string | null;
  model: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_millicents: number | null;
}

interface DailyCostRow {
  cost_millicents: string | number;
}

async function runSimulation(orgId: string, proposedSettings: AnomalySettings): Promise<SimulationResult> {
  const db = sql();

  // Fetch last 7 days of fleet events (privacy-safe columns only).
  const rows = await db<FleetEventRow[]>`
    SELECT
      ae.ts::text        AS ts,
      ae.source          AS source,
      ae.fleet_event     AS fleet_event,
      ae.fleet_outcome   AS fleet_outcome,
      ae.fleet_owner     AS fleet_owner,
      ae.repo_name       AS repo_name,
      ae.provider        AS provider,
      ae.model           AS model,
      ae.duration_ms     AS duration_ms,
      ae.tokens_input    AS tokens_input,
      ae.tokens_output   AS tokens_output,
      ae.cost_millicents AS cost_millicents
    FROM activity_event ae
    JOIN membership m ON m.user_id = ae.user_id
    WHERE m.org_id = ${orgId}::uuid
      AND ae.source  = 'ashlr-fleet'
      AND ae.ts >= NOW() - INTERVAL '7 days'
    ORDER BY ae.ts ASC
    LIMIT 2000
  `;

  if (rows.length === 0) {
    const empty = { high: 0, medium: 0, low: 0 };
    return { proposed_count: 0, current_count: 0, proposed_by_severity: empty, current_by_severity: empty, summary: "No data in the last 7 days" };
  }

  const batch: FleetRealtimeEvent[] = rows.map((r) => ({
    ts:              r.ts,
    source:          r.source,
    fleet_event:     r.fleet_event,
    fleet_outcome:   r.fleet_outcome,
    fleet_owner:     r.fleet_owner,
    repo_name:       r.repo_name,
    provider:        r.provider,
    model:           r.model,
    duration_ms:     r.duration_ms,
    tokens_input:    r.tokens_input,
    tokens_output:   r.tokens_output,
    cost_millicents: r.cost_millicents,
  }));

  // Build rolling context from the first half (baseline) vs second half (batch).
  const midpoint = Math.floor(batch.length / 2);
  const baseline = batch.slice(0, midpoint);
  const recent   = batch.slice(midpoint);

  const dailyCostRows = await db<DailyCostRow[]>`
    SELECT COALESCE(SUM(ae.cost_millicents), 0)::bigint AS cost_millicents
    FROM activity_event ae
    JOIN membership m ON m.user_id = ae.user_id
    WHERE m.org_id = ${orgId}::uuid
      AND ae.source = 'ashlr-fleet'
      AND ae.ts >= NOW() - INTERVAL '14 days'
      AND ae.ts <  NOW() - INTERVAL '7 days'
  `;
  const rollingDailyCosts = dailyCostRows.map((r) => Number(r.cost_millicents ?? 0));

  const recentEventTokens = baseline.map((e) => (e.tokens_input ?? 0) + (e.tokens_output ?? 0));
  const ownerCosts: Record<string, number> = {};
  for (const e of baseline) {
    const owner = e.fleet_owner ?? "__unknown__";
    ownerCosts[owner] = (ownerCosts[owner] ?? 0) + (e.cost_millicents ?? 0);
  }

  const context: AnomalyContext = {
    rollingDailyCosts,
    recentEventTokens,
    recentEvents: baseline,
    ownerCosts,
  };

  // Slide a window across 7d in chunks to simulate hourly detection.
  const CHUNK = 50;
  const proposedKinds = new Set<string>();
  const currentKinds  = new Set<string>();
  const proposedSev: Record<"high" | "medium" | "low", number> = { high: 0, medium: 0, low: 0 };
  const currentSev:  Record<"high" | "medium" | "low", number> = { high: 0, medium: 0, low: 0 };

  for (let i = 0; i < recent.length; i += CHUNK) {
    const chunk = recent.slice(i, i + CHUNK);
    if (chunk.length === 0) break;

    const proposed = deriveAnomaliesWithSettings(chunk, context, proposedSettings);
    const current  = deriveAnomaliesWithSettings(chunk, context, DEFAULT_ANOMALY_SETTINGS);

    for (const a of proposed) {
      if (!proposedKinds.has(a.kind)) {
        proposedKinds.add(a.kind);
        proposedSev[a.severity]++;
      }
    }
    for (const a of current) {
      if (!currentKinds.has(a.kind)) {
        currentKinds.add(a.kind);
        currentSev[a.severity]++;
      }
    }
  }

  const proposedCount = proposedKinds.size;
  const currentCount  = currentKinds.size;

  const diff = proposedCount - currentCount;
  const diffStr = diff === 0 ? "same as" : diff > 0 ? `${diff} more than` : `${Math.abs(diff)} fewer than`;

  return {
    proposed_count:       proposedCount,
    current_count:        currentCount,
    proposed_by_severity: proposedSev,
    current_by_severity:  currentSev,
    summary: `This would trigger ${proposedCount} alert type${proposedCount !== 1 ? "s" : ""} — ${diffStr} current settings (${currentCount})`,
  };
}
