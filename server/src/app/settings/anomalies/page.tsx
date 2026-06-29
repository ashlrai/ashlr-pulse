"use client";

/**
 * /settings/anomalies — Anomaly Severity Calibration Dashboard
 *
 * Exposes anomaly detection thresholds + severity classification as
 * user-configurable settings with live preview / simulation.
 *
 * Sections:
 *   1. Sensitivity slider → maps to 'conservative' | 'moderate' | 'aggressive'
 *   2. Per-detector checkboxes (enable/disable each AnomalyKind)
 *   3. Threshold override inputs (cost_spike in millicents, velocity_drop %)
 *   4. "Simulate last 7 days" button → shows alert count delta
 *   5. Save button → persists org_settings + user preferences
 *
 * Client component so the sensitivity slider + live histogram update
 * without a full page reload.
 */

import { useEffect, useState, useTransition } from "react";
import type { ReactElement } from "react";
import { palette, space, radius } from "@/lib/theme";
import type { AnomalyKind, AnomalySensitivityLevel } from "@/lib/realtime-anomaly";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DETECTOR_KINDS: AnomalyKind[] = [
  "cost_spike",
  "token_explosion",
  "tool_failure_rate",
  "model_thrash",
  "cache_miss_storm",
  "peer_divergence",
];

const KIND_META: Record<AnomalyKind, { label: string; description: string }> = {
  cost_spike:        { label: "Cost spike",        description: "Batch cost >30% above 7-day rolling daily average." },
  token_explosion:   { label: "Token explosion",   description: "Single event >3× per-event token average." },
  tool_failure_rate: { label: "Tool failure rate", description: ">20% of fleet events in a 50-event window fail." },
  model_thrash:      { label: "Model thrash",      description: ">3 distinct models in a 10-event sliding window." },
  cache_miss_storm:  { label: "Cache-miss storm",  description: ">80% of recent token-bearing events had no cache reads." },
  peer_divergence:   { label: "Peer divergence",   description: "One team member's cost-per-event >2× team average." },
};

const SENSITIVITY_LABELS: Record<AnomalySensitivityLevel, { label: string; hint: string; color: string }> = {
  conservative: { label: "Conservative", hint: "2× thresholds — fewer alerts, higher signal-to-noise",  color: palette.cyan },
  moderate:     { label: "Moderate",     hint: "Default thresholds — balanced sensitivity",               color: palette.green },
  aggressive:   { label: "Aggressive",  hint: "0.5× thresholds — more alerts, catch subtle anomalies",  color: palette.amber },
};

const SENSITIVITY_LEVELS: AnomalySensitivityLevel[] = ["conservative", "moderate", "aggressive"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgSettings {
  sensitivity_level:      AnomalySensitivityLevel;
  threshold_overrides:    { cost_spike?: number; velocity_drop?: number };
  enabled_detector_types: AnomalyKind[];
}

interface SimulationResult {
  proposed_count:       number;
  current_count:        number;
  proposed_by_severity: Record<"high" | "medium" | "low", number>;
  current_by_severity:  Record<"high" | "medium" | "low", number>;
  summary:              string;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AnomalyCalibrationPage(): ReactElement {
  const [orgSettings, setOrgSettings] = useState<OrgSettings>({
    sensitivity_level:      "moderate",
    threshold_overrides:    {},
    enabled_detector_types: [],
  });

  const [costSpikeOverride,    setCostSpikeOverride]    = useState<string>("");
  const [velocityDropOverride, setVelocityDropOverride] = useState<string>("");
  const [simulation,     setSimulation]     = useState<SimulationResult | null>(null);
  const [saveMsg,        setSaveMsg]        = useState<{ ok: boolean; text: string } | null>(null);
  const [simLoading,     setSimLoading]     = useState(false);
  const [isPending,      startTransition]   = useTransition();

  // Load current org settings on mount.
  useEffect(() => {
    fetch("/api/settings/anomalies")
      .then((r) => r.json())
      .then((data) => {
        if (data.org_settings) {
          const s: OrgSettings = data.org_settings;
          setOrgSettings(s);
          setCostSpikeOverride(s.threshold_overrides?.cost_spike != null ? String(s.threshold_overrides.cost_spike) : "");
          setVelocityDropOverride(s.threshold_overrides?.velocity_drop != null ? String(s.threshold_overrides.velocity_drop) : "");
        }
      })
      .catch(() => {/* silently ignore on SSR/no-db */});
  }, []);

  // Derived: effective enabled set (empty = all enabled)
  const enabledSet = new Set(
    orgSettings.enabled_detector_types.length === 0
      ? DETECTOR_KINDS
      : orgSettings.enabled_detector_types,
  );

  function toggleDetector(kind: AnomalyKind) {
    setOrgSettings((prev) => {
      const wasAllEnabled = prev.enabled_detector_types.length === 0;
      const current = wasAllEnabled ? new Set(DETECTOR_KINDS) : new Set(prev.enabled_detector_types);
      if (current.has(kind)) {
        current.delete(kind);
      } else {
        current.add(kind);
      }
      // If all re-enabled, collapse back to empty array (= all defaults).
      const next = [...current];
      return {
        ...prev,
        enabled_detector_types: next.length === DETECTOR_KINDS.length ? [] : next as AnomalyKind[],
      };
    });
  }

  function buildPayload(simulate: boolean) {
    const overrides: { cost_spike?: number; velocity_drop?: number } = {};
    const cs = parseFloat(costSpikeOverride);
    const vd = parseFloat(velocityDropOverride);
    if (!isNaN(cs) && cs > 0)          overrides.cost_spike    = cs;
    if (!isNaN(vd) && vd > 0 && vd <= 100) overrides.velocity_drop = vd;

    return {
      org_settings: {
        sensitivity_level:      orgSettings.sensitivity_level,
        threshold_overrides:    overrides,
        enabled_detector_types: orgSettings.enabled_detector_types,
      },
      simulate,
    };
  }

  function handleSimulate() {
    setSimLoading(true);
    setSimulation(null);
    fetch("/api/settings/anomalies", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(buildPayload(true)),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.simulation) setSimulation(data.simulation);
      })
      .finally(() => setSimLoading(false));
  }

  function handleSave() {
    setSaveMsg(null);
    startTransition(() => {
      fetch("/api/settings/anomalies", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(buildPayload(false)),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            setSaveMsg({ ok: false, text: data.error });
          } else {
            setSaveMsg({ ok: true, text: "Settings saved." });
            setTimeout(() => setSaveMsg(null), 4000);
          }
        })
        .catch(() => setSaveMsg({ ok: false, text: "Network error — settings not saved." }));
    });
  }

  const sensitivityIdx = SENSITIVITY_LEVELS.indexOf(orgSettings.sensitivity_level);
  const sensitivityMeta = SENSITIVITY_LABELS[orgSettings.sensitivity_level];

  return (
    <div style={shell}>
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: space.x5 }}>
        <h1 style={pageTitle}>Anomaly Calibration</h1>
        <p style={pageSub}>
          Tune false-positive rate for your team. Choose a global sensitivity level,
          enable/disable detector types, and override specific thresholds. Use{" "}
          <em>Simulate last 7 days</em> to preview how many alerts would fire before saving.
        </p>
        <a href="/settings" style={backLink}>← Back to settings</a>
      </div>

      {/* ── Sensitivity slider ───────────────────────────────────────────── */}
      <Section title="Global Sensitivity">
        <p style={sectionDesc}>
          Scales all detector trigger thresholds by a multiplier.{" "}
          <strong style={{ color: palette.text }}>Conservative</strong> raises thresholds (fewer alerts),{" "}
          <strong style={{ color: palette.text }}>Aggressive</strong> lowers them (more alerts).
        </p>
        <div style={{ marginTop: space.x3 }}>
          <input
            type="range"
            min={0}
            max={2}
            step={1}
            value={sensitivityIdx}
            onChange={(e) => {
              setOrgSettings((prev) => ({
                ...prev,
                sensitivity_level: SENSITIVITY_LEVELS[Number(e.target.value)],
              }));
              setSimulation(null);
            }}
            style={{ width: "100%", accentColor: sensitivityMeta.color, cursor: "pointer" }}
            aria-label="Sensitivity level"
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            {SENSITIVITY_LEVELS.map((lvl) => (
              <span key={lvl} style={{
                fontSize:   10,
                color:      lvl === orgSettings.sensitivity_level ? SENSITIVITY_LABELS[lvl].color : palette.textMute,
                fontWeight: lvl === orgSettings.sensitivity_level ? 700 : 400,
                transition: "color 0.15s",
              }}>
                {SENSITIVITY_LABELS[lvl].label}
              </span>
            ))}
          </div>
        </div>
        <div style={sensitivityBadge(sensitivityMeta.color)}>
          <span style={{ fontSize: 12, fontWeight: 600, color: sensitivityMeta.color }}>
            {sensitivityMeta.label}
          </span>
          <span style={{ fontSize: 12, color: palette.textDim, marginLeft: space.x2 }}>
            {sensitivityMeta.hint}
          </span>
        </div>
      </Section>

      {/* ── Per-detector toggles ─────────────────────────────────────────── */}
      <Section title="Detector Types">
        <p style={sectionDesc}>
          Disable detector kinds that produce noise for your team. Disabled detectors
          will not fire alerts or appear in simulation results.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.x2, marginTop: space.x3 }}>
          {DETECTOR_KINDS.map((kind) => {
            const isEnabled = enabledSet.has(kind);
            return (
              <label key={kind} style={detectorLabel(isEnabled)}>
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={() => { toggleDetector(kind); setSimulation(null); }}
                  style={{ accentColor: palette.green, width: 14, height: 14, cursor: "pointer" }}
                />
                <div>
                  <div style={{ fontSize: 12, color: isEnabled ? palette.text : palette.textMute, fontWeight: 500 }}>
                    {KIND_META[kind].label}
                  </div>
                  <div style={{ fontSize: 10, color: palette.textMute, marginTop: 2, lineHeight: 1.4 }}>
                    {KIND_META[kind].description}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </Section>

      {/* ── Threshold overrides ──────────────────────────────────────────── */}
      <Section title="Threshold Overrides">
        <p style={sectionDesc}>
          Set absolute thresholds for specific detectors. When set, these override the
          sensitivity multiplier for that detector only. Leave blank to use the sensitivity-scaled default.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.x3, marginTop: space.x3 }}>
          <OverrideInput
            label="Cost spike threshold"
            unit="millicents"
            placeholder="e.g. 200 (default: ratio-based)"
            hint="Absolute batch cost that triggers a cost_spike alert"
            value={costSpikeOverride}
            onChange={(v) => { setCostSpikeOverride(v); setSimulation(null); }}
          />
          <OverrideInput
            label="Velocity drop threshold"
            unit="%"
            placeholder="e.g. 30 (default: ratio-based)"
            hint="Event-rate drop % that triggers a velocity alert"
            value={velocityDropOverride}
            onChange={(v) => { setVelocityDropOverride(v); setSimulation(null); }}
          />
        </div>
      </Section>

      {/* ── Simulation ──────────────────────────────────────────────────── */}
      <Section title="Simulate Last 7 Days">
        <p style={sectionDesc}>
          Preview how many alerts your current settings would have fired over the
          last 7 days of fleet activity — before saving.
        </p>
        <button
          onClick={handleSimulate}
          disabled={simLoading}
          style={simulateBtn(simLoading)}
        >
          {simLoading ? "Simulating…" : "Simulate last 7 days"}
        </button>

        {simulation && <SimulationPanel result={simulation} />}
      </Section>

      {/* ── Save ────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: space.x5, display: "flex", alignItems: "center", gap: space.x3 }}>
        <button
          onClick={handleSave}
          disabled={isPending}
          style={saveBtn(isPending)}
        >
          {isPending ? "Saving…" : "Save settings"}
        </button>
        {saveMsg && (
          <span style={{ fontSize: 12, color: saveMsg.ok ? palette.green : palette.red }}>
            {saveMsg.text}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={sectionWrap}>
      <h2 style={sectionTitle}>{title}</h2>
      {children}
    </div>
  );
}

function OverrideInput({
  label, unit, placeholder, hint, value, onChange,
}: {
  label: string;
  unit: string;
  placeholder: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label style={{ fontSize: 11, color: palette.textMute, display: "block", marginBottom: 4 }}>
        {label} <span style={{ color: palette.textMute, opacity: 0.7 }}>({unit})</span>
      </label>
      <input
        type="number"
        min={0}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={overrideInput}
      />
      <span style={{ fontSize: 10, color: palette.textMute, display: "block", marginTop: 3 }}>
        {hint}
      </span>
    </div>
  );
}

function SimulationPanel({ result }: { result: SimulationResult }) {
  const SEVERITY_COLORS: Record<string, string> = {
    high:   palette.red   ?? "#f87171",
    medium: palette.amber ?? "#fbbf24",
    low:    palette.cyan  ?? "#22d3ee",
  };

  const diff = result.proposed_count - result.current_count;
  const diffColor = diff === 0 ? palette.textMute : diff < 0 ? palette.green : palette.amber;

  return (
    <div style={simulationPanel}>
      <div style={{ marginBottom: space.x3 }}>
        <span style={{ fontSize: 13, color: palette.text }}>
          {result.summary}
        </span>
        {diff !== 0 && (
          <span style={{ fontSize: 11, color: diffColor, marginLeft: space.x2 }}>
            ({diff > 0 ? "+" : ""}{diff} vs current)
          </span>
        )}
      </div>

      {/* Side-by-side severity histogram */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.x3 }}>
        <SeverityHistogram
          label="Proposed"
          counts={result.proposed_by_severity}
          colors={SEVERITY_COLORS}
        />
        <SeverityHistogram
          label="Current"
          counts={result.current_by_severity}
          colors={SEVERITY_COLORS}
        />
      </div>
    </div>
  );
}

function SeverityHistogram({
  label, counts, colors,
}: {
  label:  string;
  counts: Record<string, number>;
  colors: Record<string, string>;
}) {
  const severities: ("high" | "medium" | "low")[] = ["high", "medium", "low"];
  const total = severities.reduce((s, k) => s + (counts[k] ?? 0), 0);

  return (
    <div style={histogramWrap}>
      <div style={{ fontSize: 10, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: space.x1 }}>
        {label}
      </div>
      {severities.map((sev) => {
        const count = counts[sev] ?? 0;
        const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={sev} style={{ display: "flex", alignItems: "center", gap: space.x1, marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: colors[sev], width: 38, textTransform: "uppercase", letterSpacing: "0.3px" }}>
              {sev}
            </span>
            <div style={{ flex: 1, height: 6, background: palette.border, borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width:        `${pct}%`,
                height:       "100%",
                background:   colors[sev],
                borderRadius: 3,
                transition:   "width 0.4s ease",
              }} />
            </div>
            <span style={{ fontSize: 10, color: colors[sev], width: 14, textAlign: "right" }}>
              {count}
            </span>
          </div>
        );
      })}
      <div style={{ fontSize: 10, color: palette.textMute, marginTop: 4 }}>
        {total} alert type{total !== 1 ? "s" : ""} total
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const shell: React.CSSProperties = {
  maxWidth:  680,
  margin:    "0 auto",
  padding:   `${space.x5}px ${space.x3}px`,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

const pageTitle: React.CSSProperties = {
  fontSize:      22,
  fontWeight:    600,
  margin:        0,
  color:         palette.text,
  letterSpacing: "-0.5px",
};

const pageSub: React.CSSProperties = {
  color:        palette.textDim,
  fontSize:     13,
  marginTop:    space.x1,
  marginBottom: space.x1,
  lineHeight:   1.6,
};

const backLink: React.CSSProperties = {
  fontSize:       11,
  color:          palette.textMute,
  textDecoration: "none",
};

const sectionWrap: React.CSSProperties = {
  border:       `1px solid ${palette.border}`,
  borderRadius: radius.md,
  padding:      space.x4,
  marginBottom: space.x4,
  background:   palette.bgSurface,
};

const sectionTitle: React.CSSProperties = {
  fontSize:      13,
  fontWeight:    600,
  color:         palette.text,
  margin:        `0 0 ${space.x1}px`,
  letterSpacing: "0.2px",
};

const sectionDesc: React.CSSProperties = {
  fontSize:   12,
  color:      palette.textDim,
  lineHeight: 1.6,
  margin:     `${space.x1}px 0 0`,
};

function sensitivityBadge(color: string): React.CSSProperties {
  return {
    display:      "flex",
    alignItems:   "center",
    marginTop:    space.x3,
    padding:      `${space.x1}px ${space.x2}px`,
    background:   `${color}12`,
    border:       `1px solid ${color}30`,
    borderRadius: radius.sm,
  };
}

function detectorLabel(isEnabled: boolean): React.CSSProperties {
  return {
    display:      "flex",
    alignItems:   "flex-start",
    gap:          space.x1,
    padding:      space.x2,
    border:       `1px solid ${isEnabled ? palette.borderHi : palette.border}`,
    borderRadius: radius.sm,
    background:   isEnabled ? palette.bgRaised : palette.bgSurface,
    cursor:       "pointer",
    transition:   "border-color 0.15s, background 0.15s",
  };
}

const overrideInput: React.CSSProperties = {
  width:        "100%",
  background:   palette.bgRaised,
  border:       `1px solid ${palette.border}`,
  borderRadius: radius.sm,
  color:        palette.text,
  fontSize:     12,
  padding:      `${space.x1}px ${space.x2}px`,
  outline:      "none",
  boxSizing:    "border-box",
};

function simulateBtn(loading: boolean): React.CSSProperties {
  return {
    marginTop:    space.x3,
    padding:      `${space.x1}px ${space.x3}px`,
    background:   loading ? palette.bgRaised : palette.bgRaised,
    border:       `1px solid ${loading ? palette.border : palette.cyan}`,
    borderRadius: radius.sm,
    color:        loading ? palette.textMute : palette.cyan,
    fontSize:     12,
    cursor:       loading ? "default" : "pointer",
    transition:   "border-color 0.15s, color 0.15s",
  };
}

function saveBtn(pending: boolean): React.CSSProperties {
  return {
    padding:      `${space.x1}px ${space.x4}px`,
    background:   pending ? palette.bgRaised : palette.green,
    border:       "none",
    borderRadius: radius.sm,
    color:        pending ? palette.textMute : palette.bg,
    fontSize:     13,
    fontWeight:   600,
    cursor:       pending ? "default" : "pointer",
    transition:   "background 0.15s",
  };
}

const simulationPanel: React.CSSProperties = {
  marginTop:    space.x3,
  padding:      space.x3,
  background:   palette.bgRaised,
  border:       `1px solid ${palette.borderHi}`,
  borderRadius: radius.sm,
};

const histogramWrap: React.CSSProperties = {
  padding:      space.x2,
  background:   palette.bgSurface,
  border:       `1px solid ${palette.border}`,
  borderRadius: radius.sm,
};
