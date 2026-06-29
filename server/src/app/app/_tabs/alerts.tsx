"use client";

/**
 * alerts.tsx — Alerts tab for the /app dashboard.
 *
 * Renders a live, priority-sorted feed of realtime anomalies detected by the
 * realtime-anomaly engine. Anomalies are persisted to the anomaly_event table
 * by /api/cron/anomaly-persist and surfaced here from the server-rendered
 * initial props. New anomalies arriving via SSE are appended live via the
 * "pulse:anomaly" custom DOM event dispatched by DashboardSSE.tsx.
 *
 * Sort order: worst-first by severity (high → medium → low), then by
 * timestamp descending within the same severity.
 *
 * Privacy: anomalies contain only aggregate numeric/enum metadata — no
 * prompts, completions, code, or PII beyond repo_name (already visible
 * elsewhere on the dashboard).
 */

import { useEffect, useRef, useState } from "react";
import type { RealtimeAnomaly, AnomalySeverity } from "@/lib/realtime-anomaly";
import { palette, space } from "@/lib/theme";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A persisted anomaly row from the anomaly_event table (server-rendered). */
export interface PersistedAnomaly {
  id: string;
  ts: string;
  severity: AnomalySeverity;
  kind: string;
  repo_name: string | null;
  message: string;
  dismissed_at: string | null;
}

export interface AlertsTabProps {
  /** Server-rendered initial list from anomaly_event table. */
  anomalies: PersistedAnomaly[];
  /** org_id — used for dismiss action. */
  orgId: string;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  high:   palette.red    ?? "#f87171",
  medium: palette.amber  ?? "#fbbf24",
  low:    palette.cyan   ?? "#22d3ee",
};

/**
 * Extract a human-readable reasoning string from the anomaly's context_json.
 * Prefers the "sigma_reasoning" field written by settings-aware detectors,
 * falls back to a generic description built from the raw numeric fields.
 */
function extractReasoning(anomaly: PersistedAnomaly): string | null {
  // context_json may be stored as a string or already parsed object.
  let ctx: Record<string, unknown> | null = null;
  try {
    const raw = (anomaly as unknown as { context_json?: unknown }).context_json;
    if (typeof raw === "string") ctx = JSON.parse(raw) as Record<string, unknown>;
    else if (raw && typeof raw === "object") ctx = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!ctx) return null;

  // Prefer explicit sigma_reasoning written by scaled detectors.
  if (typeof ctx.sigma_reasoning === "string" && ctx.sigma_reasoning) {
    return ctx.sigma_reasoning;
  }

  // Build a fallback from known numeric fields.
  if (typeof ctx.ratio === "number") {
    const avg = typeof ctx.rolling_avg_millicents === "number"
      ? ` (${ctx.rolling_avg_millicents.toLocaleString()} mc avg)`
      : typeof ctx.rolling_avg_tokens === "number"
        ? ` (${ctx.rolling_avg_tokens.toLocaleString()} tok avg)`
        : "";
    return `${ctx.ratio.toFixed(1)}× above baseline${avg}`;
  }
  if (typeof ctx.failure_rate === "number") {
    return `${Math.round(ctx.failure_rate * 100)}% failure rate`;
  }
  if (typeof ctx.miss_rate === "number") {
    return `${Math.round(ctx.miss_rate * 100)}% cache-miss rate`;
  }
  if (typeof ctx.distinct_models === "number") {
    return `${ctx.distinct_models} distinct models in window`;
  }
  return null;
}

const KIND_LABEL: Record<string, string> = {
  cost_spike:        "cost spike",
  token_explosion:   "token explosion",
  tool_failure_rate: "tool failures",
  model_thrash:      "model thrashing",
  cache_miss_storm:  "cache misses",
  peer_divergence:   "peer divergence",
};

// ─── Live anomaly feed state ──────────────────────────────────────────────────

/** Convert a RealtimeAnomaly (from SSE) to a display-compatible shape. */
function liveToDisplay(a: RealtimeAnomaly): PersistedAnomaly {
  return {
    id:           `live-${a.kind}-${Date.now()}`,
    ts:           new Date().toISOString(),
    severity:     a.severity,
    kind:         a.kind,
    repo_name:    a.repo_name,
    message:      a.message,
    dismissed_at: null,
  };
}

function sortAnomalies(list: PersistedAnomaly[]): PersistedAnomaly[] {
  return [...list].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    // Within same severity: most-recent first.
    return new Date(b.ts).getTime() - new Date(a.ts).getTime();
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AlertsTab({ anomalies: initialAnomalies }: AlertsTabProps) {
  const [anomalies, setAnomalies] = useState<PersistedAnomaly[]>(
    () => sortAnomalies(initialAnomalies.filter((a) => !a.dismissed_at)),
  );
  const [liveCount, setLiveCount] = useState(0);
  const seenIds = useRef(new Set(initialAnomalies.map((a) => a.id)));

  // Listen for live anomaly events dispatched by DashboardSSE.
  useEffect(() => {
    function onPulseAnomaly(e: Event) {
      const { anomalies: live } = (e as CustomEvent<{ anomalies: RealtimeAnomaly[] }>).detail;
      if (!Array.isArray(live) || live.length === 0) return;

      setLiveCount((c) => c + live.length);
      setAnomalies((prev) => {
        const next = [...prev];
        for (const a of live) {
          const display = liveToDisplay(a);
          // Deduplicate by kind within the last 60 seconds.
          const recentDup = next.find(
            (x) =>
              x.kind === a.kind &&
              Date.now() - new Date(x.ts).getTime() < 60_000,
          );
          if (recentDup) continue;
          if (!seenIds.current.has(display.id)) {
            seenIds.current.add(display.id);
            next.push(display);
          }
        }
        return sortAnomalies(next);
      });
    }

    window.addEventListener("pulse:anomaly", onPulseAnomaly);
    return () => window.removeEventListener("pulse:anomaly", onPulseAnomaly);
  }, []);

  const activeCount = anomalies.filter((a) => !a.dismissed_at).length;

  return (
    <div style={{ marginTop: space.x5 }}>
      {/* Header strip */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: space.x3,
        marginBottom: space.x4,
      }}>
        <span style={{
          fontSize: 10,
          color: palette.textMute,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
        }}>
          alerts
        </span>
        {activeCount > 0 && (
          <span style={{
            fontSize: 10,
            color: palette.red ?? "#f87171",
            background: `${palette.red ?? "#f87171"}18`,
            border: `1px solid ${palette.red ?? "#f87171"}40`,
            borderRadius: 4,
            padding: "1px 6px",
            fontVariantNumeric: "tabular-nums",
          }}>
            {activeCount} active
          </span>
        )}
        {liveCount > 0 && (
          <span style={{
            fontSize: 10,
            color: palette.cyan,
            letterSpacing: "0.3px",
          }}>
            +{liveCount} live
          </span>
        )}
        {/* Settings calibration link */}
        <a
          href="/settings/anomalies"
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: palette.textMute,
            textDecoration: "none",
            letterSpacing: "0.3px",
            opacity: 0.8,
          }}
          title="Calibrate anomaly thresholds"
        >
          ⚙ calibrate
        </a>
      </div>

      {anomalies.length === 0 ? (
        <EmptyState />
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {anomalies.map((a) => (
            <AlertRow key={a.id} anomaly={a} onDismiss={() => {
              setAnomalies((prev) =>
                prev.map((x) =>
                  x.id === a.id ? { ...x, dismissed_at: new Date().toISOString() } : x,
                ).filter((x) => !x.dismissed_at),
              );
            }} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── AlertRow ─────────────────────────────────────────────────────────────────

function AlertRow({
  anomaly,
  onDismiss,
}: {
  anomaly: PersistedAnomaly;
  onDismiss: () => void;
}) {
  const color  = SEVERITY_COLOR[anomaly.severity];
  const label  = KIND_LABEL[anomaly.kind] ?? anomaly.kind;
  const isLive = anomaly.id.startsWith("live-");

  return (
    <li style={{
      display:        "grid",
      gridTemplateColumns: "auto 1fr auto",
      alignItems:     "start",
      gap:            space.x3,
      padding:        `${space.x3} 0`,
      borderBottom:   `1px dashed ${palette.border}`,
    }}>
      {/* Severity dot + kind badge */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 90 }}>
        <span style={{
          display:       "inline-flex",
          alignItems:    "center",
          gap:           4,
          fontSize:      10,
          color,
          textTransform: "uppercase",
          letterSpacing: "0.4px",
          fontWeight:    600,
        }}>
          <span style={{
            width:        6,
            height:       6,
            borderRadius: "50%",
            background:   color,
            flexShrink:   0,
          }} />
          {anomaly.severity}
        </span>
        <span style={{
          fontSize:      9,
          color:         palette.textMute,
          textTransform: "uppercase",
          letterSpacing: "0.3px",
        }}>
          {label}
        </span>
      </div>

      {/* Message + metadata */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize:   12,
          color:      palette.textDim,
          lineHeight: 1.5,
          wordBreak:  "break-word",
        }}>
          {anomaly.message}
        </div>
        {/* Reasoning line — shows σ / ratio above baseline */}
        {(() => {
          const reasoning = extractReasoning(anomaly);
          return reasoning ? (
            <div style={{
              fontSize:    10,
              color:       color,
              opacity:     0.75,
              marginTop:   3,
              fontVariantNumeric: "tabular-nums",
            }}>
              {reasoning}
            </div>
          ) : null;
        })()}
        <div style={{ display: "flex", gap: space.x2, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          {anomaly.repo_name && (
            <span style={{ fontSize: 10, color: palette.cyan }}>
              {anomaly.repo_name}
            </span>
          )}
          <span style={{ fontSize: 10, color: palette.textMute }}>
            {fmtAgo(new Date(anomaly.ts))}
          </span>
          {isLive && (
            <span style={{
              fontSize:      9,
              color:         palette.green ?? "#4ade80",
              textTransform: "uppercase",
              letterSpacing: "0.3px",
            }}>
              live
            </span>
          )}
          {/* Settings shortcut */}
          <a
            href="/settings/anomalies"
            style={{
              fontSize:       9,
              color:          palette.textMute,
              textDecoration: "none",
              opacity:        0.6,
              marginLeft:     "auto",
            }}
            title="Adjust anomaly thresholds"
          >
            tune
          </a>
        </div>
      </div>

      {/* Dismiss button */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss alert"
        style={{
          background:  "transparent",
          border:      "none",
          cursor:      "pointer",
          color:       palette.textMute,
          fontSize:    14,
          padding:     "2px 4px",
          lineHeight:  1,
          borderRadius: 3,
          transition:  "color 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = palette.textDim;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = palette.textMute;
        }}
      >
        ×
      </button>
    </li>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      padding:        `${space.x6} ${space.x4}`,
      textAlign:      "center",
      border:         `1px dashed ${palette.border}`,
      borderRadius:   8,
      color:          palette.textMute,
      fontSize:       12,
      lineHeight:     1.7,
    }}>
      <div style={{ color: palette.green ?? "#4ade80", fontSize: 11, letterSpacing: "0.4px", textTransform: "uppercase", marginBottom: 6 }}>
        all clear
      </div>
      No anomalies detected in the current window.{" "}
      <span style={{ color: palette.textMute }}>
        The detector watches for cost spikes, token explosions, high failure
        rates, model thrashing, cache-miss storms, and peer activity divergence.
      </span>
    </div>
  );
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function fmtAgo(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
