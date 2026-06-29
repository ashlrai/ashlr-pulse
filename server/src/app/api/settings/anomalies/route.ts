/**
 * GET  /api/settings/anomalies — load the current user's anomaly alert preferences.
 * POST /api/settings/anomalies — upsert the current user's anomaly alert preferences.
 *
 * GET response shape:
 *   {
 *     preferences: Record<AnomalyKind, AnomalyPreference>
 *   }
 *
 * POST body shape (partial — only include kinds you want to change):
 *   {
 *     preferences: {
 *       [kind: AnomalyKind]: {
 *         enabled?: boolean,
 *         severity_low_threshold?: number,  // 0.1 – 10.0
 *         severity_high_threshold?: number  // 0.1 – 10.0
 *       }
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

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Validation schema
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

const PostBodySchema = z.object({
  preferences: z.record(AnomalyKindEnum, SinglePrefSchema),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const preferences = await getEffectivePreferences(me.id);
  return NextResponse.json({ preferences });
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

  // Load current effective preferences (fills in defaults for missing kinds).
  const current = await getEffectivePreferences(me.id);

  // Merge incoming changes onto current state.
  const updates: Partial<AnomalyPreferenceMap> = {};
  for (const [rawKind, patch] of Object.entries(parsed.data.preferences)) {
    const kind = rawKind as (typeof ANOMALY_KINDS)[number];
    const existing: AnomalyPreference = current[kind];
    updates[kind] = {
      kind,
      enabled:                 patch.enabled                 ?? existing.enabled,
      severity_low_threshold:  patch.severity_low_threshold  ?? existing.severity_low_threshold,
      severity_high_threshold: patch.severity_high_threshold ?? existing.severity_high_threshold,
    };
  }

  await upsertPreferences(me.id, updates);

  // Return the full updated preference map.
  const updated = await getEffectivePreferences(me.id);
  return NextResponse.json({ preferences: updated });
}
