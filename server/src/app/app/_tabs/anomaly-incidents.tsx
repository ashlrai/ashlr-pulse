"use client";

/**
 * anomaly-incidents.tsx — Anomaly Incidents tab for the /app dashboard.
 *
 * Renders a timeline of grouped anomaly incidents. Each incident card shows:
 *   - Kind icon + severity badge
 *   - Event count and time span (first → last seen)
 *   - Cost impact (for cost_spike incidents)
 *   - Repo list, owner list, model list from context
 *
 * Clicking a card opens a side panel showing:
 *   - Full event sequence metadata (first/last alert, max severity, event count)
 *   - Related span IDs with a link to the Timeline tab for drill-down
 *   - Context arrays (repos, models, owners)
 *
 * Privacy: incident context carries only numeric/enum metadata — no prompts,
 * completions, file content, or PII beyond repo_name / owner handles already
 * visible in the Alerts tab.
 */

import { useState } from "react";
import type { AnomalySeverity } from "@/lib/realtime-anomaly";
import { palette, space } from "@/lib/theme";
import type { AnomalyIncidentRow } from "@/app/api/dashboard/anomaly-incidents/route";

// ─── Re-export the row type for consumers ─────────────────────────────────────

export type { AnomalyIncidentRow };

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AnomalyIncidentsTabProps {
  incidents:  AnomalyIncidentRow[];
  windowDays: number;
  /** org_id — used to build timeline drill-down hrefs */
  orgId: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  high:   palette.red    ?? "#f87171",
  medium: palette.amber  ?? "#fbbf24",
  low:    palette.cyan   ?? "#22d3ee",
};

const KIND_ICON: Record<string, string> = {
  cost_spike:        "$",
  token_explosion:   "T",
  tool_failure_rate: "!",
  model_thrash:      "~",
  cache_miss_storm:  "C",
  peer_divergence:   "P",
};

const KIND_LABEL: Record<string, string> = {
  cost_spike:        "Cost Spike",
  token_explosion:   "Token Explosion",
  tool_failure_rate: "Tool Failures",
  model_thrash:      "Model Thrashing",
  cache_miss_storm:  "Cache Miss Storm",
  peer_divergence:   "Peer Divergence",
};

// ─── Utility ──────────────────────────────────────────────────────────────────

function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtDuration(first: string, last: string): string {
  const ms = Math.abs(new Date(last).getTime() - new Date(first).getTime());
  const m  = Math.round(ms / 60_000);
  if (m < 60)   return `${m}m span`;
  return `${Math.round(m / 60)}h span`;
}

function fmtMillicents(mc: number): string {
  if (mc === 0) return "";
  const usd = mc / 100_000;
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

// ─── Side panel ───────────────────────────────────────────────────────────────

function IncidentSidePanel({
  incident,
  onClose,
}: {
  incident: AnomalyIncidentRow;
  onClose:  () => void;
}) {
  const color  = SEVERITY_COLOR[incident.severity];
  const label  = KIND_LABEL[incident.kind] ?? incident.kind;
  const icon   = KIND_ICON[incident.kind]  ?? "?";
  const isClosed = !!incident.closed_at;
  const costStr  = fmtMillicents(incident.cost_impact_millicents);
  const spanStr  = fmtDuration(incident.first_detected_at, incident.last_seen_at);

  return (
    <div style={{
      position:        "fixed",
      top:             0,
      right:           0,
      bottom:          0,
      width:           360,
      background:      palette.bgSurface,
      borderLeft:      `1px solid ${palette.border}`,
      zIndex:          100,
      overflowY:       "auto",
      display:         "flex",
      flexDirection:   "column",
      padding:         space.x4,
      boxSizing:       "border-box",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: space.x3, marginBottom: space.x4 }}>
        <span style={{
          width:        28,
          height:       28,
          borderRadius: 6,
          background:   `${color}22`,
          border:       `1px solid ${color}44`,
          display:      "flex",
          alignItems:   "center",
          justifyContent: "center",
          fontSize:     13,
          fontWeight:   700,
          color,
          flexShrink:   0,
        }}>
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>{label}</div>
          <div style={{ fontSize: 10, color: palette.textMute, marginTop: 2 }}>
            {isClosed ? "closed" : "open"} · {spanStr}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background:   "transparent",
            border:       "none",
            cursor:       "pointer",
            color:        palette.textMute,
            fontSize:     18,
            padding:      "2px 6px",
            lineHeight:   1,
            borderRadius: 3,
          }}
        >
          ×
        </button>
      </div>

      {/* Severity badge */}
      <div style={{ display: "flex", gap: space.x2, marginBottom: space.x4, flexWrap: "wrap" }}>
        <span style={{
          fontSize:      10,
          color,
          background:    `${color}18`,
          border:        `1px solid ${color}40`,
          borderRadius:  4,
          padding:       "2px 8px",
          textTransform: "uppercase",
          letterSpacing: "0.4px",
          fontWeight:    600,
        }}>
          {incident.severity}
        </span>
        {isClosed && (
          <span style={{
            fontSize:      10,
            color:         palette.textMute,
            background:    `${palette.border}80`,
            borderRadius:  4,
            padding:       "2px 8px",
            textTransform: "uppercase",
            letterSpacing: "0.4px",
          }}>
            closed
          </span>
        )}
      </div>

      {/* Metrics */}
      <Section label="Event Sequence">
        <MetaRow label="First detected" value={fmtAgo(incident.first_detected_at)} />
        <MetaRow label="Last seen"      value={fmtAgo(incident.last_seen_at)} />
        {isClosed && incident.closed_at && (
          <MetaRow label="Closed"       value={fmtAgo(incident.closed_at)} />
        )}
        <MetaRow label="Event count"    value={String(incident.event_count)} />
        <MetaRow label="Max severity"   value={incident.severity} valueColor={color} />
        {costStr && (
          <MetaRow label="Cost impact"  value={costStr} valueColor={palette.amber} />
        )}
      </Section>

      {/* Context arrays */}
      {incident.context.repo_names.length > 0 && (
        <Section label="Repos">
          <TagList tags={incident.context.repo_names} color={palette.cyan} />
        </Section>
      )}

      {incident.context.owners.length > 0 && (
        <Section label="Owners">
          <TagList tags={incident.context.owners} color={palette.magenta} />
        </Section>
      )}

      {incident.context.models.length > 0 && (
        <Section label="Models">
          <TagList tags={incident.context.models} color={palette.purple} />
        </Section>
      )}

      {/* Span IDs — link to timeline */}
      {incident.context.span_ids.length > 0 && (
        <Section label={`Related Events (${incident.context.span_ids.length})`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {incident.context.span_ids.slice(0, 20).map((sid) => (
              <a
                key={sid}
                href={`?tab=timeline&event=${sid}`}
                style={{
                  fontSize:       10,
                  color:          palette.cyan,
                  fontFamily:     "monospace",
                  textDecoration: "none",
                  wordBreak:      "break-all",
                  opacity:        0.8,
                }}
                title="Open in Timeline tab"
              >
                {sid}
              </a>
            ))}
            {incident.context.span_ids.length > 20 && (
              <span style={{ fontSize: 10, color: palette.textMute }}>
                +{incident.context.span_ids.length - 20} more
              </span>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: space.x4 }}>
      <div style={{
        fontSize:      9,
        color:         palette.textMute,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        marginBottom:  space.x1,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function MetaRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: space.x2, marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: palette.textMute }}>{label}</span>
      <span style={{ fontSize: 11, color: valueColor ?? palette.textDim, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function TagList({ tags, color }: { tags: string[]; color: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {tags.map((t) => (
        <span key={t} style={{
          fontSize:     10,
          color,
          background:   `${color}18`,
          border:       `1px solid ${color}30`,
          borderRadius: 4,
          padding:      "2px 6px",
        }}>
          {t}
        </span>
      ))}
    </div>
  );
}

// ─── Incident card ────────────────────────────────────────────────────────────

function IncidentCard({
  incident,
  onClick,
}: {
  incident: AnomalyIncidentRow;
  onClick:  () => void;
}) {
  const color   = SEVERITY_COLOR[incident.severity];
  const label   = KIND_LABEL[incident.kind]  ?? incident.kind;
  const icon    = KIND_ICON[incident.kind]   ?? "?";
  const isClosed = !!incident.closed_at;
  const costStr  = fmtMillicents(incident.cost_impact_millicents);
  const spanStr  = fmtDuration(incident.first_detected_at, incident.last_seen_at);

  return (
    <li
      onClick={onClick}
      style={{
        display:       "flex",
        alignItems:    "flex-start",
        gap:           space.x3,
        padding:       `${space.x3} ${space.x3}`,
        borderBottom:  `1px dashed ${palette.border}`,
        cursor:        "pointer",
        borderRadius:  4,
        transition:    "background 0.12s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLLIElement).style.background = palette.bgRaised;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLLIElement).style.background = "transparent";
      }}
    >
      {/* Icon */}
      <span style={{
        width:          28,
        height:         28,
        borderRadius:   6,
        background:     `${color}22`,
        border:         `1px solid ${color}44`,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        fontSize:       12,
        fontWeight:     700,
        color,
        flexShrink:     0,
        marginTop:      2,
        opacity:        isClosed ? 0.5 : 1,
      }}>
        {icon}
      </span>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap", marginBottom: 3 }}>
          <span style={{
            fontSize:      11,
            fontWeight:    600,
            color:         isClosed ? palette.textMute : palette.text,
          }}>
            {label}
          </span>
          {/* Severity badge */}
          <span style={{
            fontSize:      9,
            color,
            background:    `${color}18`,
            border:        `1px solid ${color}40`,
            borderRadius:  3,
            padding:       "1px 5px",
            textTransform: "uppercase",
            letterSpacing: "0.4px",
            opacity:       isClosed ? 0.6 : 1,
          }}>
            {incident.severity}
          </span>
          {isClosed && (
            <span style={{
              fontSize:      9,
              color:         palette.textMute,
              background:    `${palette.border}80`,
              borderRadius:  3,
              padding:       "1px 5px",
              textTransform: "uppercase",
            }}>
              closed
            </span>
          )}
        </div>

        {/* Summary line */}
        <div style={{ fontSize: 11, color: palette.textDim, marginBottom: 4 }}>
          {incident.event_count} event{incident.event_count !== 1 ? "s" : ""} · {spanStr}
          {costStr && (
            <span style={{ color: palette.amber, marginLeft: space.x2 }}>{costStr}</span>
          )}
        </div>

        {/* Tags row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 2 }}>
          {incident.context.repo_names.slice(0, 3).map((r) => (
            <span key={r} style={{ fontSize: 9, color: palette.cyan }}>{r}</span>
          ))}
          {incident.context.repo_names.length > 3 && (
            <span style={{ fontSize: 9, color: palette.textMute }}>
              +{incident.context.repo_names.length - 3} repos
            </span>
          )}
          {incident.context.owners.slice(0, 2).map((o) => (
            <span key={o} style={{ fontSize: 9, color: palette.magenta }}>{o}</span>
          ))}
        </div>

        {/* Timestamp */}
        <div style={{ fontSize: 9, color: palette.textMute }}>
          {fmtAgo(incident.first_detected_at)}
        </div>
      </div>

      {/* Chevron */}
      <span style={{ fontSize: 10, color: palette.textMute, marginTop: 8, flexShrink: 0 }}>›</span>
    </li>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AnomalyIncidentsTab({
  incidents: initialIncidents,
  windowDays,
}: AnomalyIncidentsTabProps) {
  const [selected, setSelected] = useState<AnomalyIncidentRow | null>(null);

  // Split open vs closed.
  const open   = initialIncidents.filter((i) => !i.closed_at);
  const closed = initialIncidents.filter((i) =>  i.closed_at);

  return (
    <div style={{ marginTop: space.x5, position: "relative" }}>
      {/* Header */}
      <div style={{
        display:       "flex",
        alignItems:    "center",
        gap:           space.x3,
        marginBottom:  space.x4,
      }}>
        <span style={{
          fontSize:      10,
          color:         palette.textMute,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
        }}>
          incidents
        </span>
        {open.length > 0 && (
          <span style={{
            fontSize:   10,
            color:      palette.red ?? "#f87171",
            background: `${palette.red ?? "#f87171"}18`,
            border:     `1px solid ${palette.red ?? "#f87171"}40`,
            borderRadius: 4,
            padding:    "1px 6px",
            fontVariantNumeric: "tabular-nums",
          }}>
            {open.length} open
          </span>
        )}
        <span style={{ fontSize: 10, color: palette.textMute }}>
          last {windowDays}d
        </span>
        <a
          href="/settings/anomalies"
          style={{
            marginLeft:     "auto",
            fontSize:       10,
            color:          palette.textMute,
            textDecoration: "none",
            letterSpacing:  "0.3px",
            opacity:        0.8,
          }}
          title="Calibrate anomaly thresholds"
        >
          ⚙ calibrate
        </a>
      </div>

      {initialIncidents.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Open incidents */}
          {open.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: `0 0 ${space.x5}px` }}>
              {open.map((inc) => (
                <IncidentCard
                  key={inc.id}
                  incident={inc}
                  onClick={() => setSelected(inc)}
                />
              ))}
            </ul>
          )}

          {/* Closed incidents (collapsed section) */}
          {closed.length > 0 && (
            <details>
              <summary style={{
                fontSize:      10,
                color:         palette.textMute,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                cursor:        "pointer",
                marginBottom:  space.x3,
                userSelect:    "none",
              }}>
                {closed.length} closed incident{closed.length !== 1 ? "s" : ""}
              </summary>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {closed.map((inc) => (
                  <IncidentCard
                    key={inc.id}
                    incident={inc}
                    onClick={() => setSelected(inc)}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {/* Side panel overlay */}
      {selected && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSelected(null)}
            style={{
              position:   "fixed",
              inset:      0,
              background: "rgba(5,5,5,0.6)",
              zIndex:     99,
            }}
          />
          <IncidentSidePanel incident={selected} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      padding:      `${space.x6}px ${space.x4}px`,
      textAlign:    "center",
      border:       `1px dashed ${palette.border}`,
      borderRadius: 8,
      color:        palette.textMute,
      fontSize:     12,
      lineHeight:   1.7,
    }}>
      <div style={{
        color:         palette.green ?? "#4ade80",
        fontSize:      11,
        letterSpacing: "0.4px",
        textTransform: "uppercase",
        marginBottom:  6,
      }}>
        no incidents
      </div>
      No anomaly incidents in the current window. Incidents are automatically
      created when related anomalies are detected within a 2-hour window across
      the same repo or owner scope.
    </div>
  );
}
