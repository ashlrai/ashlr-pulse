"use client";

/**
 * FleetCostRealtime.tsx — Realtime SSE-driven fleet cost-impact widget.
 *
 * Opens an SSE connection to /api/fleet/cost-impact/subscribe and renders:
 *
 *   1. Stacked-bar chart — time × event-type, bars colored by outcome
 *      (approval = green, rejection = red, pending = amber, other = cyan).
 *
 *   2. Cost sparkline — rolling mini-bar chart of total cost per window.
 *
 *   3. Delta badges — "+$12.50 vs baseline" per bucket, colored by variance.
 *
 * Props:
 *   userId            — the authenticated user's ID (own events)
 *   peerUserId        — optional: pass ?as= peer-share owner to watch their events
 *   initialCostImpact — server-rendered OrgCostImpact snapshot for baseline display
 *
 * Privacy floor: all values displayed are pure numeric aggregates from
 * CostImpactWindow / OrgCostImpact. No prompts, completions, or code appear.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { OrgCostImpact } from "@/lib/fleet-cost-impact";
import { palette, space, radius, cardStyle, font } from "@/lib/theme";
import type { CostImpactWindow, CostImpactBucket } from "@/app/api/fleet/cost-impact/subscribe/route";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of 5-minute windows to keep in the rolling history. */
const MAX_WINDOWS = 12; // 60 minutes of history

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  userId: string;
  peerUserId?: string;
  initialCostImpact: OrgCostImpact | null;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function outcomeColor(outcome: string): string {
  switch (outcome.toLowerCase()) {
    case "approved":
    case "applied":
    case "merged":
      return palette.green;
    case "rejected":
    case "failed":
    case "reverted":
      return palette.red;
    case "pending":
    case "claimed":
      return palette.amber;
    default:
      return palette.cyan;
  }
}

function varianceBadgeColor(pct: number): string {
  if (pct > 50)   return palette.red;
  if (pct > 10)   return palette.amber;
  if (pct < -10)  return palette.green;
  return palette.textDim;
}

function fmtMillicents(mc: number): string {
  // millicents → dollars: 1 USD = 100,000 mc
  const usd = mc / 100_000;
  if (Math.abs(usd) < 0.01) return usd >= 0 ? "<$0.01" : ">-$0.01";
  return `${usd >= 0 ? "" : "-"}$${Math.abs(usd).toFixed(2)}`;
}

function fmtDelta(mc: number): string {
  const sign = mc >= 0 ? "+" : "-";
  const usd  = Math.abs(mc) / 100_000;
  if (usd < 0.01) return `${sign}<$0.01`;
  return `${sign}$${usd.toFixed(2)}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Mini-sparkline of total cost per window (pure SVG). */
function CostSparkline({ windows }: { windows: CostImpactWindow[] }): ReactElement {
  const W = 120, H = 28, barW = 6, gap = 3;
  const values = windows.map((w) => w.totalMillicents);
  const max    = Math.max(...values, 1);

  return (
    <svg width={W} height={H} style={{ display: "block", flexShrink: 0 }}>
      {values.map((v, i) => {
        const barH = Math.max(2, Math.round((v / max) * H));
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={H - barH}
            width={barW}
            height={barH}
            rx={1}
            fill={palette.cyan}
            fillOpacity={0.45 + 0.55 * (v / max)}
          />
        );
      })}
    </svg>
  );
}

/** Stacked-bar chart: x = window time, each bar segment = (event_type, outcome). */
function StackedBarChart({ windows }: { windows: CostImpactWindow[] }): ReactElement {
  const W = "100%";
  const H = 120;
  const barW = Math.max(12, Math.floor(340 / Math.max(windows.length, 1)) - 4);
  const maxTotal = Math.max(...windows.map((w) => w.totalMillicents), 1);

  return (
    <div
      style={{
        overflowX: "auto",
        paddingBottom: space.x1,
      }}
    >
      <div
        style={{
          display:     "flex",
          alignItems:  "flex-end",
          gap:         4,
          height:      H,
          minWidth:    windows.length * (barW + 4),
        }}
      >
        {windows.map((win, wi) => {
          const totalH = Math.max(2, Math.round((win.totalMillicents / maxTotal) * (H - 20)));

          return (
            <div
              key={wi}
              title={`${fmtTime(win.windowStart)} – ${fmtTime(win.windowEnd)}\nTotal: ${fmtMillicents(win.totalMillicents)}\nΔ vs baseline: ${fmtDelta(win.deltaMillicents)}`}
              style={{
                display:       "flex",
                flexDirection: "column-reverse",
                width:         barW,
                height:        totalH,
                borderRadius:  `${radius.sm}px ${radius.sm}px 0 0`,
                overflow:      "hidden",
                flexShrink:    0,
                cursor:        "default",
              }}
            >
              {win.buckets.map((b, bi) => {
                const segH = win.totalMillicents > 0
                  ? Math.max(1, Math.round((b.total_millicents / win.totalMillicents) * totalH))
                  : 0;
                return (
                  <div
                    key={bi}
                    title={`${b.fleet_event} / ${b.fleet_outcome}: ${fmtMillicents(b.total_millicents)}`}
                    style={{
                      width:      "100%",
                      height:     segH,
                      background: outcomeColor(b.fleet_outcome),
                      flexShrink: 0,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* X-axis time labels */}
      <div
        style={{
          display:  "flex",
          gap:      4,
          minWidth: windows.length * (barW + 4),
          marginTop: 3,
        }}
      >
        {windows.map((win, wi) => (
          <div
            key={wi}
            style={{
              width:     barW,
              fontSize:  9,
              color:     palette.textMute,
              textAlign: "center",
              fontFamily: font.mono,
              flexShrink: 0,
              overflow:  "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {fmtTime(win.windowStart)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Delta badge per bucket: shows event label + cost delta vs baseline. */
function BucketBadge({ bucket, baselineMillicents }: { bucket: CostImpactBucket; baselineMillicents: number }): ReactElement {
  const expected = baselineMillicents * bucket.event_count;
  const delta    = bucket.total_millicents - expected;
  const varPct   = expected > 0 ? (delta / expected) * 100 : 0;
  const color    = varianceBadgeColor(varPct);

  return (
    <div
      style={{
        display:      "flex",
        alignItems:   "center",
        gap:          space.x1,
        padding:      `${space.x05}px ${space.x1}px`,
        background:   palette.bgRaised,
        border:       `1px solid ${palette.border}`,
        borderRadius: radius.md,
        flexShrink:   0,
      }}
    >
      {/* Outcome dot */}
      <span
        style={{
          width:        7,
          height:       7,
          borderRadius: "50%",
          background:   outcomeColor(bucket.fleet_outcome),
          flexShrink:   0,
        }}
      />

      {/* Event label */}
      <span
        style={{
          fontSize:   11,
          fontFamily: font.mono,
          color:      palette.textDim,
        }}
      >
        {bucket.fleet_event}/{bucket.fleet_outcome}
      </span>

      {/* Cost */}
      <span
        style={{
          fontSize:           11,
          fontFamily:         font.mono,
          color:              palette.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtMillicents(bucket.total_millicents)}
      </span>

      {/* Delta badge */}
      <span
        style={{
          fontSize:           11,
          fontFamily:         font.mono,
          color,
          background:         `${color}18`,
          borderRadius:       radius.sm,
          padding:            "1px 5px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtDelta(delta)} vs baseline
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FleetCostRealtime({ userId, peerUserId, initialCostImpact }: Props): ReactElement {
  const [windows, setWindows] = useState<CostImpactWindow[]>([]);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Derive initial baseline from server snapshot.
  const baselineMillicents = initialCostImpact?.teamAvgDailyMillicents
    ? initialCostImpact.teamAvgDailyMillicents / (24 * 12) // daily → 5-minute equivalent
    : 0;

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = new URL("/api/fleet/cost-impact/subscribe", window.location.origin);
    if (peerUserId) url.searchParams.set("as", peerUserId);

    const es = new EventSource(url.toString());
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setErr(null);
    };

    es.onmessage = (evt) => {
      try {
        const win: CostImpactWindow = JSON.parse(evt.data);
        // Only append real windows (ignore heartbeat comments — they don't
        // trigger onmessage, only data: lines do).
        if (win.windowStart) {
          setWindows((prev) => {
            const next = [...prev, win];
            return next.length > MAX_WINDOWS ? next.slice(-MAX_WINDOWS) : next;
          });
        }
      } catch {
        // Malformed — ignore.
      }
    };

    es.onerror = () => {
      setConnected(false);
      setErr("SSE connection lost — reconnecting…");
      es.close();
      esRef.current = null;
      // Exponential-ish back-off: retry after 4 s.
      setTimeout(connect, 4_000);
    };
  }, [peerUserId]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);

  // Latest window for delta badges.
  const latest = windows.at(-1) ?? null;
  const effectiveBaseline = latest?.baselineMillicents ?? baselineMillicents;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

      {/* Status strip */}
      <div style={{ display: "flex", alignItems: "center", gap: space.x2 }}>
        <span
          style={{
            width:        8,
            height:       8,
            borderRadius: "50%",
            background:   connected ? palette.green : palette.amber,
            flexShrink:   0,
          }}
        />
        <span style={{ fontSize: 12, color: palette.textDim }}>
          {connected ? "Live — 5-minute rolling windows" : err ?? "Connecting…"}
        </span>
        {windows.length > 0 && (
          <span style={{ fontSize: 11, color: palette.textMute, marginLeft: "auto" }}>
            {windows.length} window{windows.length !== 1 ? "s" : ""} · last{" "}
            {latest ? fmtTime(latest.windowEnd) : ""}
          </span>
        )}
      </div>

      {/* Summary stat row */}
      {latest && (
        <div style={{ display: "flex", gap: space.x3, flexWrap: "wrap" }}>
          <StatBadge label="Total (window)" value={fmtMillicents(latest.totalMillicents)} />
          <StatBadge
            label="Δ vs baseline"
            value={fmtDelta(latest.deltaMillicents)}
            color={varianceBadgeColor(latest.variancePct)}
          />
          <StatBadge
            label="Variance"
            value={`${latest.variancePct > 0 ? "+" : ""}${latest.variancePct.toFixed(1)}%`}
            color={varianceBadgeColor(latest.variancePct)}
          />
          <StatBadge label="Event types" value={String(latest.buckets.length)} />
        </div>
      )}

      {/* Stacked-bar chart */}
      <div style={cardStyle({ padding: space.x4 })}>
        <div
          style={{
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            marginBottom:   space.x3,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>
            Cost by Event Type × Outcome
          </span>
          {windows.length > 0 && <CostSparkline windows={windows} />}
        </div>

        {windows.length === 0 ? (
          <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
            Waiting for fleet events…
          </p>
        ) : (
          <StackedBarChart windows={windows} />
        )}

        {/* Color legend */}
        <div style={{ display: "flex", gap: space.x3, marginTop: space.x3, flexWrap: "wrap" }}>
          {[
            { label: "approved/applied",      color: palette.green },
            { label: "rejected/failed",        color: palette.red },
            { label: "pending/claimed",        color: palette.amber },
            { label: "other",                  color: palette.cyan },
          ].map(({ label, color }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span
                style={{
                  width:        8,
                  height:       8,
                  borderRadius: 2,
                  background:   color,
                  flexShrink:   0,
                }}
              />
              <span style={{ fontSize: 11, color: palette.textMute }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Delta badges per bucket (latest window) */}
      {latest && latest.buckets.length > 0 && (
        <div style={cardStyle({ padding: space.x4 })}>
          <p
            style={{
              fontSize:    13,
              fontWeight:  600,
              color:       palette.text,
              margin:      `0 0 ${space.x3}px`,
            }}
          >
            Latest Window — Cost Attribution
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: space.x2 }}>
            {latest.buckets.map((b, i) => (
              <BucketBadge
                key={`${b.fleet_event}:${b.fleet_outcome}:${i}`}
                bucket={b}
                baselineMillicents={effectiveBaseline}
              />
            ))}
          </div>
        </div>
      )}

      {/* Initial org-level snapshot (7-day) — displayed until live data arrives */}
      {initialCostImpact && initialCostImpact.users.length > 0 && windows.length === 0 && (
        <div style={cardStyle({ padding: space.x4 })}>
          <p
            style={{
              fontSize:   13,
              fontWeight: 600,
              color:      palette.text,
              margin:     `0 0 ${space.x3}px`,
            }}
          >
            7-Day Baseline Snapshot
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: space.x1 }}>
            {initialCostImpact.users.slice(0, 8).map((u) => (
              <div
                key={u.userId}
                style={{
                  display:     "flex",
                  alignItems:  "center",
                  gap:         space.x2,
                  fontSize:    12,
                  color:       palette.textDim,
                }}
              >
                <span
                  style={{
                    fontFamily:         font.mono,
                    color:              palette.text,
                    fontVariantNumeric: "tabular-nums",
                    minWidth:           80,
                  }}
                >
                  {fmtMillicents(u.totalMillicents)}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: 11 }}>
                  {u.userId.slice(0, 8)}…
                </span>
                <span style={{ fontSize: 11, color: palette.textMute }}>
                  {u.dailyAvgMillicents > 0 ? `${fmtMillicents(u.dailyAvgMillicents)}/day avg` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatBadge
// ---------------------------------------------------------------------------

function StatBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}): ReactElement {
  return (
    <div
      style={{
        ...cardStyle(),
        padding:       `${space.x1}px ${space.x2}px`,
        display:       "flex",
        flexDirection: "column",
        gap:           3,
        minWidth:      90,
      }}
    >
      <span
        style={{
          fontSize:      10,
          color:         palette.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.6px",
          fontFamily:    font.mono,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize:           16,
          fontWeight:         600,
          color:              color ?? palette.text,
          fontVariantNumeric: "tabular-nums",
          fontFamily:         font.mono,
        }}
      >
        {value}
      </span>
    </div>
  );
}
