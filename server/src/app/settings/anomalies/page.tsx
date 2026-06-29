/**
 * /settings/anomalies — Anomaly Alert Preferences
 *
 * Lets users configure per-kind anomaly alert toggles (on/off) and custom
 * severity thresholds. Changes POST to /api/settings/anomalies.
 *
 * Server component — loads current preferences on render. No client state.
 * Form submissions use Next.js Server Actions (same pattern as /settings).
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import {
  getEffectivePreferences,
  upsertPreferences,
  ANOMALY_KINDS,
  type AnomalyPreference,
  type AnomalyPreferenceMap,
} from "@/lib/anomaly-preference-db";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Input";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { ok?: string; error?: string }

// ---------------------------------------------------------------------------
// Kind metadata
// ---------------------------------------------------------------------------

const KIND_META: Record<string, { label: string; description: string }> = {
  cost_spike: {
    label: "Cost spike",
    description: "Fires when the batch cost is >30% above the 7-day rolling daily average.",
  },
  token_explosion: {
    label: "Token explosion",
    description: "Fires when a single event uses >3× the rolling per-event token average.",
  },
  tool_failure_rate: {
    label: "Tool failure rate",
    description: "Fires when >20% of fleet events in a 50-event window fail.",
  },
  model_thrash: {
    label: "Model thrash",
    description: "Fires when >3 distinct models appear in a 10-event sliding window.",
  },
  cache_miss_storm: {
    label: "Cache-miss storm",
    description: "Fires when >80% of recent token-bearing events have no cache reads.",
  },
  peer_divergence: {
    label: "Peer divergence",
    description: "Fires when one team member's cost-per-event is >2× the team average.",
  },
};

// ---------------------------------------------------------------------------
// Server action — save preferences
// ---------------------------------------------------------------------------

async function saveAnomalyPreferencesAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const updates: Partial<AnomalyPreferenceMap> = {};

  for (const kind of ANOMALY_KINDS) {
    const enabled = formData.get(`enabled_${kind}`) === "on";
    const lowRaw  = String(formData.get(`low_${kind}`)  ?? "1.0").trim();
    const highRaw = String(formData.get(`high_${kind}`) ?? "1.0").trim();

    const low  = Math.max(0.1, Math.min(10.0, Number(lowRaw)  || 1.0));
    const high = Math.max(0.1, Math.min(10.0, Number(highRaw) || 1.0));

    updates[kind] = {
      kind,
      enabled,
      severity_low_threshold:  low,
      severity_high_threshold: high,
    } satisfies AnomalyPreference;
  }

  await upsertPreferences(me.id, updates);
  revalidatePath("/settings/anomalies");
  redirect("/settings/anomalies?ok=1");
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function AnomalyPreferencesPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const prefs = await getEffectivePreferences(me.id);

  return (
    <DashboardShell maxWidth={700}>
      <Header me={me} active="settings" />

      <h1 style={pageTitle}>Anomaly Alert Preferences</h1>
      <div style={pageSub}>
        Configure which anomaly types fire alerts in your live feed, and tune
        severity escalation thresholds. Threshold multipliers scale the
        built-in severity boundaries — 1.0 means default, 2.0 means you need
        twice the ratio to escalate severity.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok    && <Banner variant="success">Preferences saved.</Banner>}
        {params.error && <Banner variant="danger">{params.error}</Banner>}

        <form action={saveAnomalyPreferencesAction}>
          {ANOMALY_KINDS.map((kind) => {
            const pref = prefs[kind];
            const meta = KIND_META[kind];

            return (
              <Card key={kind} style={{ marginBottom: space.x3 }}>
                <CardHeader
                  title={meta.label}
                  hint={kind}
                />
                <p style={descStyle}>{meta.description}</p>

                {/* Toggle */}
                <Field label="Enable alerts for this kind">
                  <label style={toggleLabel}>
                    <input
                      type="checkbox"
                      name={`enabled_${kind}`}
                      defaultChecked={pref.enabled}
                      style={{ accentColor: palette.green, width: 16, height: 16 }}
                    />
                    <span style={{ color: pref.enabled ? palette.green : palette.textDim }}>
                      {pref.enabled ? "enabled" : "disabled"}
                    </span>
                  </label>
                </Field>

                {/* Severity thresholds */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.x3, marginTop: space.x2 }}>
                  <Field
                    label="Low → medium threshold multiplier"
                    hint="default: 1.0"
                  >
                    <input
                      type="range"
                      name={`low_${kind}`}
                      min="0.1"
                      max="5.0"
                      step="0.1"
                      defaultValue={pref.severity_low_threshold}
                      style={{ width: "100%", accentColor: palette.green }}
                    />
                    <span style={thresholdHint}>
                      {pref.severity_low_threshold.toFixed(1)}×
                    </span>
                  </Field>

                  <Field
                    label="Medium → high threshold multiplier"
                    hint="default: 1.0"
                  >
                    <input
                      type="range"
                      name={`high_${kind}`}
                      min="0.1"
                      max="5.0"
                      step="0.1"
                      defaultValue={pref.severity_high_threshold}
                      style={{ width: "100%", accentColor: palette.green }}
                    />
                    <span style={thresholdHint}>
                      {pref.severity_high_threshold.toFixed(1)}×
                    </span>
                  </Field>
                </div>
              </Card>
            );
          })}

          <div style={{ marginTop: space.x4 }}>
            <Button type="submit" variant="primary">Save preferences</Button>
          </div>
        </form>
      </div>
    </DashboardShell>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const pageTitle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text,
  letterSpacing: "-0.5px",
};

const pageSub: React.CSSProperties = {
  color: palette.textDim,
  fontSize: 13,
  marginBottom: space.x5,
  lineHeight: 1.6,
};

const descStyle: React.CSSProperties = {
  color: palette.textDim,
  fontSize: 12,
  lineHeight: 1.6,
  margin: `0 0 ${space.x2}px`,
};

const toggleLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
  color: palette.text,
  cursor: "pointer",
};

const thresholdHint: React.CSSProperties = {
  fontSize: 11,
  color: palette.textMute,
  display: "block",
  marginTop: 4,
};
