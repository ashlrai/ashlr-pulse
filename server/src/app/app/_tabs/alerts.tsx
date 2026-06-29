"use client";

/**
 * alerts.tsx — Alerts tab for the /app dashboard.
 *
 * Renders anomalies in two views:
 *
 *   1. Incidents view (default) — groups related anomalies into incidents
 *      fetched from /api/dashboard/anomaly-incidents. Each incident shows:
 *        - Root-cause signal badge
 *        - Auto-generated description narrative
 *        - Severity score (0-100)
 *        - Expand/collapse to see member anomaly details
 *        - Remediation cards: "Mark Resolved", "Dismiss", "View Details",
 *          and per-remediation action buttons
 *
 *   2. Raw feed — individual persisted anomaly_event rows (legacy view,
 *      toggled by the "show raw" link). Unchanged from the original design.
 *
 * Privacy: anomalies/incidents contain only aggregate numeric/enum metadata.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeAnomaly, AnomalySeverity } from "@/lib/realtime-anomaly";
import { palette, space } from "@/lib/theme";
import type { EnrichedIncidentRow } from "@/app/api/dashboard/anomaly-incidents/route";
import type { RemediationRow } from "@/lib/anomaly-remediation-db";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  anomalies: PersistedAnomaly[];
  orgId: string;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  high:   palette.red    ?? "#f87171",
  medium: palette.amber  ?? "#fbbf24",
  low:    palette.cyan   ?? "#22d3ee",
};

const ROOT_CAUSE_LABEL: Record<string, string> = {
  new_model_thrashing:                   "model thrashing",
  cost_spike_with_high_rejection_rate:   "cost + rejections",
  cache_miss_storm:                      "cache miss storm",
  token_explosion_single_repo:           "token explosion",
  peer_cost_divergence:                  "peer divergence",
  tool_failure_cascade:                  "tool failures",
  generic_cost_spike:                    "cost spike",
};

const REMEDIATION_LABEL: Record<string, string> = {
  reduce_token_window:  "Reduce Token Window",
  switch_model:         "Switch Model",
  increase_budget:      "Increase Budget",
  review_cache_config:  "Review Cache Config",
  investigate_failures: "Investigate Failures",
  investigate_peer:     "Investigate Peer Activity",
};

const KIND_LABEL: Record<string, string> = {
  cost_spike:        "cost spike",
  token_explosion:   "token explosion",
  tool_failure_rate: "tool failures",
  model_thrash:      "model thrashing",
  cache_miss_storm:  "cache misses",
  peer_divergence:   "peer divergence",
};

// ─── Reasoning extractor (raw feed) ──────────────────────────────────────────

function extractReasoning(anomaly: PersistedAnomaly): string | null {
  let ctx: Record<string, unknown> | null = null;
  try {
    const raw = (anomaly as unknown as { context_json?: unknown }).context_json;
    if (typeof raw === "string") ctx = JSON.parse(raw) as Record<string, unknown>;
    else if (raw && typeof raw === "object") ctx = raw as Record<string, unknown>;
  } catch { return null; }
  if (!ctx) return null;
  if (typeof ctx.sigma_reasoning === "string" && ctx.sigma_reasoning) return ctx.sigma_reasoning;
  if (typeof ctx.ratio === "number") {
    const avg = typeof ctx.rolling_avg_millicents === "number"
      ? ` (${ctx.rolling_avg_millicents.toLocaleString()} mc avg)`
      : typeof ctx.rolling_avg_tokens === "number"
        ? ` (${ctx.rolling_avg_tokens.toLocaleString()} tok avg)`
        : "";
    return `${ctx.ratio.toFixed(1)}× above baseline${avg}`;
  }
  if (typeof ctx.failure_rate === "number") return `${Math.round(ctx.failure_rate * 100)}% failure rate`;
  if (typeof ctx.miss_rate    === "number") return `${Math.round(ctx.miss_rate    * 100)}% cache-miss rate`;
  if (typeof ctx.distinct_models === "number") return `${ctx.distinct_models} distinct models in window`;
  return null;
}

// ─── State helpers ────────────────────────────────────────────────────────────

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
    return new Date(b.ts).getTime() - new Date(a.ts).getTime();
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AlertsTab({ anomalies: initialAnomalies, orgId }: AlertsTabProps) {
  const [anomalies, setAnomalies] = useState<PersistedAnomaly[]>(
    () => sortAnomalies(initialAnomalies.filter((a) => !a.dismissed_at)),
  );
  const [liveCount, setLiveCount]     = useState(0);
  const [showRaw,   setShowRaw]       = useState(false);
  const [incidents, setIncidents]     = useState<EnrichedIncidentRow[] | null>(null);
  const [loadingInc, setLoadingInc]   = useState(false);
  const [incError,   setIncError]     = useState<string | null>(null);
  const seenIds = useRef(new Set(initialAnomalies.map((a) => a.id)));

  // Fetch incidents on first render (incidents view).
  useEffect(() => {
    if (showRaw || incidents !== null || loadingInc) return;
    setLoadingInc(true);
    fetch(`/api/dashboard/anomaly-incidents?orgId=${encodeURIComponent(orgId)}&win=7`)
      .then((r) => r.json())
      .then((data: { incidents: EnrichedIncidentRow[] }) => {
        setIncidents(data.incidents ?? []);
      })
      .catch((err: unknown) => {
        setIncError(err instanceof Error ? err.message : "Failed to load incidents");
      })
      .finally(() => setLoadingInc(false));
  }, [orgId, showRaw, incidents, loadingInc]);

  // SSE live anomaly feed.
  useEffect(() => {
    function onPulseAnomaly(e: Event) {
      const { anomalies: live } = (e as CustomEvent<{ anomalies: RealtimeAnomaly[] }>).detail;
      if (!Array.isArray(live) || live.length === 0) return;
      setLiveCount((c) => c + live.length);
      setAnomalies((prev) => {
        const next = [...prev];
        for (const a of live) {
          const display = liveToDisplay(a);
          const recentDup = next.find(
            (x) => x.kind === a.kind && Date.now() - new Date(x.ts).getTime() < 60_000,
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

  const handleIncidentAction = useCallback(
    async (action: "update_incident" | "update_remediation", payload: Record<string, string>) => {
      const res = await fetch("/api/dashboard/anomaly-incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      if (res.ok) {
        // Refresh incidents.
        setIncidents(null);
      }
    },
    [],
  );

  const activeCount = anomalies.filter((a) => !a.dismissed_at).length;
  const openIncidentCount = incidents?.filter((i) => i.status === "open").length ?? 0;

  return (
    <div style={{ marginTop: space.x5 }}>
      {/* Header strip */}
      <div style={{ display: "flex", alignItems: "center", gap: space.x3, marginBottom: space.x4 }}>
        <span style={{ fontSize: 10, color: palette.textMute, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          alerts
        </span>
        {!showRaw && openIncidentCount > 0 && (
          <span style={{
            fontSize: 10, color: palette.red ?? "#f87171",
            background: `${palette.red ?? "#f87171"}18`,
            border: `1px solid ${palette.red ?? "#f87171"}40`,
            borderRadius: 4, padding: "1px 6px", fontVariantNumeric: "tabular-nums",
          }}>
            {openIncidentCount} incident{openIncidentCount !== 1 ? "s" : ""}
          </span>
        )}
        {showRaw && activeCount > 0 && (
          <span style={{
            fontSize: 10, color: palette.red ?? "#f87171",
            background: `${palette.red ?? "#f87171"}18`,
            border: `1px solid ${palette.red ?? "#f87171"}40`,
            borderRadius: 4, padding: "1px 6px", fontVariantNumeric: "tabular-nums",
          }}>
            {activeCount} active
          </span>
        )}
        {liveCount > 0 && (
          <span style={{ fontSize: 10, color: palette.cyan, letterSpacing: "0.3px" }}>
            +{liveCount} live
          </span>
        )}
        {/* View toggle */}
        <button
          onClick={() => setShowRaw((v) => !v)}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            fontSize: 10, color: palette.textMute, letterSpacing: "0.3px",
            padding: 0, textDecoration: "underline",
          }}
        >
          {showRaw ? "show incidents" : "show raw"}
        </button>
        <a
          href="/settings/anomalies"
          style={{ marginLeft: "auto", fontSize: 10, color: palette.textMute, textDecoration: "none", letterSpacing: "0.3px", opacity: 0.8 }}
          title="Calibrate anomaly thresholds"
        >
          ⚙ calibrate
        </a>
      </div>

      {/* Incidents view */}
      {!showRaw && (
        <>
          {loadingInc && (
            <div style={{ padding: space.x4, textAlign: "center", color: palette.textMute, fontSize: 11 }}>
              loading incidents…
            </div>
          )}
          {incError && (
            <div style={{ padding: space.x3, color: palette.red ?? "#f87171", fontSize: 11 }}>
              {incError}
            </div>
          )}
          {!loadingInc && !incError && incidents !== null && (
            incidents.filter((i) => i.status === "open").length === 0 ? (
              <EmptyState />
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {incidents
                  .filter((i) => i.status === "open")
                  .map((inc) => (
                    <IncidentRow
                      key={inc.id}
                      incident={inc}
                      onResolve={() => handleIncidentAction("update_incident", { incidentId: inc.id, status: "resolved" })}
                      onDismiss={() => handleIncidentAction("update_incident", { incidentId: inc.id, status: "dismissed" })}
                      onRemediation={(remId, status) =>
                        handleIncidentAction("update_remediation", { remediationId: remId, status })
                      }
                    />
                  ))}
              </ul>
            )
          )}
        </>
      )}

      {/* Raw anomaly feed (legacy) */}
      {showRaw && (
        anomalies.length === 0 ? (
          <EmptyState />
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {anomalies.map((a) => (
              <AlertRow key={a.id} anomaly={a} onDismiss={() => {
                setAnomalies((prev) =>
                  prev.map((x) => x.id === a.id ? { ...x, dismissed_at: new Date().toISOString() } : x)
                    .filter((x) => !x.dismissed_at),
                );
              }} />
            ))}
          </ul>
        )
      )}
    </div>
  );
}

// ─── IncidentRow ──────────────────────────────────────────────────────────────

function IncidentRow({
  incident,
  onResolve,
  onDismiss,
  onRemediation,
}: {
  incident:      EnrichedIncidentRow;
  onResolve:     () => void;
  onDismiss:     () => void;
  onRemediation: (remId: string, status: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color      = SEVERITY_COLOR[incident.severity];
  const signalLabel = ROOT_CAUSE_LABEL[incident.root_cause_signal ?? ""] ?? incident.root_cause_signal ?? incident.kind;
  const scoreColor  = incident.severity_score >= 80
    ? (palette.red    ?? "#f87171")
    : incident.severity_score >= 50
      ? (palette.amber  ?? "#fbbf24")
      : (palette.cyan   ?? "#22d3ee");

  return (
    <li style={{
      border:       `1px solid ${palette.border}`,
      borderRadius: 6,
      marginBottom: space.x3,
      background:   palette.bgSurface,
      overflow:     "hidden",
    }}>
      {/* Incident header */}
      <div
        style={{ padding: `${space.x3} ${space.x4}`, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.x3, flexWrap: "wrap" }}>
          {/* Severity dot */}
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.4px", fontWeight: 600,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
            {incident.severity}
          </span>

          {/* Root-cause signal badge */}
          <span style={{
            fontSize: 9, color: scoreColor,
            background: `${scoreColor}18`, border: `1px solid ${scoreColor}40`,
            borderRadius: 3, padding: "1px 5px", textTransform: "uppercase", letterSpacing: "0.4px",
          }}>
            {signalLabel}
          </span>

          {/* Severity score */}
          <span style={{ fontSize: 10, color: scoreColor, fontVariantNumeric: "tabular-nums" }}>
            score {incident.severity_score}
          </span>

          {/* Event count */}
          <span style={{ fontSize: 10, color: palette.textMute }}>
            {incident.event_count} event{incident.event_count !== 1 ? "s" : ""}
          </span>

          {/* Repos */}
          {incident.context.repo_names.length > 0 && (
            <span style={{ fontSize: 10, color: palette.cyan }}>
              {incident.context.repo_names.slice(0, 2).join(", ")}
              {incident.context.repo_names.length > 2 ? ` +${incident.context.repo_names.length - 2}` : ""}
            </span>
          )}

          {/* Timestamp */}
          <span style={{ fontSize: 10, color: palette.textMute, marginLeft: "auto" }}>
            {fmtAgo(new Date(incident.first_detected_at))}
          </span>

          {/* Expand chevron */}
          <span style={{ fontSize: 10, color: palette.textMute, transition: "transform 0.15s", display: "inline-block", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
            ›
          </span>
        </div>

        {/* Description narrative */}
        {incident.description && (
          <div style={{ marginTop: 6, fontSize: 12, color: palette.textDim, lineHeight: 1.5 }}>
            {incident.description}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${palette.border}`, padding: `${space.x3} ${space.x4}` }}>
          {/* Member anomaly kinds */}
          <div style={{ marginBottom: space.x3 }}>
            <span style={{ fontSize: 9, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px" }}>
              anomaly kinds
            </span>
            <div style={{ display: "flex", gap: space.x2, flexWrap: "wrap", marginTop: 4 }}>
              <span style={{
                fontSize: 10, color, background: `${color}18`, border: `1px solid ${color}40`,
                borderRadius: 3, padding: "1px 6px",
              }}>
                {KIND_LABEL[incident.kind] ?? incident.kind}
              </span>
              {incident.context.models.length > 0 && (
                <span style={{ fontSize: 10, color: palette.textMute }}>
                  models: {incident.context.models.slice(0, 3).join(", ")}
                </span>
              )}
              {incident.context.owners.length > 0 && (
                <span style={{ fontSize: 10, color: palette.textMute }}>
                  owners: {incident.context.owners.slice(0, 3).join(", ")}
                </span>
              )}
            </div>
          </div>

          {/* Remediation cards */}
          {incident.remediations.length > 0 && (
            <div style={{ marginBottom: space.x3 }}>
              <span style={{ fontSize: 9, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px" }}>
                suggested actions
              </span>
              <div style={{ display: "flex", gap: space.x2, flexWrap: "wrap", marginTop: 4 }}>
                {incident.remediations.map((rem) => (
                  <RemediationCard
                    key={rem.id}
                    remediation={rem}
                    onApply={() => onRemediation(rem.id, "applied")}
                    onDismiss={() => onRemediation(rem.id, "dismissed")}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Incident-level actions */}
          <div style={{ display: "flex", gap: space.x2, marginTop: space.x2 }}>
            <ActionButton label="Mark Resolved" color={palette.green ?? "#7CFFA0"} onClick={onResolve} />
            <ActionButton label="Dismiss"       color={palette.textMute}            onClick={onDismiss} />
          </div>
        </div>
      )}
    </li>
  );
}

// ─── RemediationCard ──────────────────────────────────────────────────────────

function RemediationCard({
  remediation,
  onApply,
  onDismiss,
}: {
  remediation: RemediationRow;
  onApply:     () => void;
  onDismiss:   () => void;
}) {
  const isDone  = remediation.status === "applied" || remediation.status === "dismissed";
  const label   = REMEDIATION_LABEL[remediation.remediation_kind] ?? remediation.remediation_kind;
  const color   = remediation.status === "applied"
    ? (palette.green ?? "#7CFFA0")
    : remediation.status === "dismissed"
      ? palette.textMute
      : palette.cyan ?? "#7CD0FF";

  return (
    <div style={{
      border:       `1px solid ${color}40`,
      borderRadius: 5,
      padding:      `${space.x2} ${space.x3}`,
      background:   `${color}0a`,
      opacity:      isDone ? 0.55 : 1,
      minWidth:     120,
    }}>
      <div style={{ fontSize: 10, color, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 9, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 6 }}>
        {remediation.status}
      </div>
      {!isDone && (
        <div style={{ display: "flex", gap: space.x2 }}>
          <button
            onClick={onApply}
            style={{ fontSize: 9, color: palette.green ?? "#7CFFA0", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            Apply
          </button>
          <button
            onClick={onDismiss}
            style={{ fontSize: 9, color: palette.textMute, background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ActionButton ─────────────────────────────────────────────────────────────

function ActionButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 10, color, background: `${color}18`,
        border: `1px solid ${color}40`, borderRadius: 4,
        padding: "3px 10px", cursor: "pointer", letterSpacing: "0.3px",
      }}
    >
      {label}
    </button>
  );
}

// ─── AlertRow (raw feed) ──────────────────────────────────────────────────────

function AlertRow({ anomaly, onDismiss }: { anomaly: PersistedAnomaly; onDismiss: () => void }) {
  const color  = SEVERITY_COLOR[anomaly.severity];
  const label  = KIND_LABEL[anomaly.kind] ?? anomaly.kind;
  const isLive = anomaly.id.startsWith("live-");

  return (
    <li style={{
      display: "grid", gridTemplateColumns: "auto 1fr auto",
      alignItems: "start", gap: space.x3, padding: `${space.x3} 0`,
      borderBottom: `1px dashed ${palette.border}`,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 90 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.4px", fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
          {anomaly.severity}
        </span>
        <span style={{ fontSize: 9, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.3px" }}>
          {label}
        </span>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: palette.textDim, lineHeight: 1.5, wordBreak: "break-word" }}>
          {anomaly.message}
        </div>
        {(() => {
          const reasoning = extractReasoning(anomaly);
          return reasoning ? (
            <div style={{ fontSize: 10, color, opacity: 0.75, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
              {reasoning}
            </div>
          ) : null;
        })()}
        <div style={{ display: "flex", gap: space.x2, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          {anomaly.repo_name && <span style={{ fontSize: 10, color: palette.cyan }}>{anomaly.repo_name}</span>}
          <span style={{ fontSize: 10, color: palette.textMute }}>{fmtAgo(new Date(anomaly.ts))}</span>
          {isLive && <span style={{ fontSize: 9, color: palette.green ?? "#4ade80", textTransform: "uppercase", letterSpacing: "0.3px" }}>live</span>}
          <a href="/settings/anomalies" style={{ fontSize: 9, color: palette.textMute, textDecoration: "none", opacity: 0.6, marginLeft: "auto" }} title="Adjust anomaly thresholds">tune</a>
        </div>
      </div>

      <button
        onClick={onDismiss}
        aria-label="Dismiss alert"
        style={{ background: "transparent", border: "none", cursor: "pointer", color: palette.textMute, fontSize: 14, padding: "2px 4px", lineHeight: 1, borderRadius: 3, transition: "color 0.15s" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = palette.textDim; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = palette.textMute; }}
      >
        ×
      </button>
    </li>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ padding: `${space.x6} ${space.x4}`, textAlign: "center", border: `1px dashed ${palette.border}`, borderRadius: 8, color: palette.textMute, fontSize: 12, lineHeight: 1.7 }}>
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
