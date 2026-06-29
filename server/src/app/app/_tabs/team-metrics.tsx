"use client";
/**
 * team-metrics.tsx — Team Metrics tab
 *
 * Renders three collaborative metric views:
 *   (a) Velocity vector scatter plot (Recharts): each developer as a point
 *       at (avg daily events, cost trend slope), color-coded by token trend.
 *   (b) Pairing heatmap: 12 two-hour UTC buckets × N developer pairs,
 *       color-coded by co-active day count.
 *   (c) Modal detail view for a pair: top 3 shared repos + combined cost trend.
 *
 * This is a client component because it needs useState (modal) and useEffect
 * (fetch). Data is loaded fresh on mount via /api/dashboard/team-metrics.
 *
 * Privacy floor: only aggregate counts are displayed — no prompts, no content.
 */

import { useState, useEffect, useCallback } from "react";
import type { ReactElement } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";
import { palette, space } from "@/lib/theme";
import type { VelocityVector, PairCompatibility, PairingHeatmapCell } from "@/lib/team-velocity-profiler";

// ─── Shared colour helpers ────────────────────────────────────────────────────

const PAIR_COLORS = [
  palette.cyan, palette.green, palette.amber, "#a78bfa", "#f472b6",
  "#34d399", "#fb923c", "#60a5fa", "#e879f9", "#4ade80",
];

function pairColor(idx: number): string {
  return PAIR_COLORS[idx % PAIR_COLORS.length];
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamMetricsData {
  velocityVectors:   VelocityVector[];
  pairCompatibility: PairCompatibility[];
  pairingHeatmap:    PairingHeatmapCell[];
  windowDays:        number;
}

interface Props {
  orgId: string;
  windowDays?: number;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TeamMetricsTab({ orgId, windowDays = 30 }: Props): ReactElement {
  const [data, setData]       = useState<TeamMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [selectedPair, setSelectedPair] = useState<PairCompatibility | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/dashboard/team-metrics?orgId=${encodeURIComponent(orgId)}&win=${windowDays}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setData(await res.json() as TeamMetricsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load team metrics");
    } finally {
      setLoading(false);
    }
  }, [orgId, windowDays]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div style={{ marginTop: space.x4, color: palette.textDim, fontSize: 13 }}>
        Loading team metrics…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ marginTop: space.x4, color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data || data.velocityVectors.length === 0) {
    return (
      <div style={{
        marginTop: space.x4,
        padding: 24,
        textAlign: "center",
        color: palette.textDim,
        fontSize: 13,
        border: `1px dashed ${palette.border}`,
        borderRadius: 8,
      }}>
        No team activity data for the selected window. Add more teammates to your org or share activity via peer-share.
      </div>
    );
  }

  return (
    <div style={{ marginTop: space.x4 }}>
      <VelocityScatter vectors={data.velocityVectors} />
      <PairingHeatmapGrid
        heatmap={data.pairingHeatmap}
        pairs={data.pairCompatibility}
        onSelectPair={setSelectedPair}
      />
      {selectedPair && (
        <PairDetailModal
          pair={selectedPair}
          vectors={data.velocityVectors}
          onClose={() => setSelectedPair(null)}
        />
      )}
    </div>
  );
}

// ─── (a) Velocity vector scatter plot ────────────────────────────────────────

function VelocityScatter({ vectors }: { vectors: VelocityVector[] }): ReactElement {
  // Plot: x = avgDailyEvents, y = costTrendSlope (millicents/day)
  // Color intensity = tokenTrendSlope (positive = green, negative = amber)
  const points = vectors.map((v, i) => ({
    userId: v.userId,
    x: v.avgDailyEvents,
    y: v.costTrendSlope,
    tokenSlope: v.tokenTrendSlope,
    color: pairColor(i),
    label: shortId(v.userId),
  }));

  return (
    <section style={{ marginBottom: space.x6 }}>
      <SectionHeader title="Developer velocity vectors" hint={`avg daily events vs cost trend · last ${vectors[0] ? "7" : "?"}d`} />
      <div style={{
        background: palette.bgSurface,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "16px 8px 8px",
      }}>
        <ResponsiveContainer width="100%" height={280}>
          <ScatterChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={palette.border} />
            <XAxis
              type="number"
              dataKey="x"
              name="avg daily events"
              tick={{ fill: palette.textDim, fontSize: 10 }}
              label={{ value: "avg daily events", position: "insideBottom", offset: -4, fill: palette.textDim, fontSize: 10 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="cost trend (mc/day)"
              tick={{ fill: palette.textDim, fontSize: 10 }}
              label={{ value: "cost trend (mc/d)", angle: -90, position: "insideLeft", fill: palette.textDim, fontSize: 10 }}
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0]?.payload as typeof points[0] | undefined;
                if (!d) return null;
                return (
                  <div style={{ background: palette.bgSurface, border: `1px solid ${palette.border}`, borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
                    <div style={{ color: d.color, fontWeight: 600 }}>{d.label}</div>
                    <div style={{ color: palette.textDim }}>events/day: {d.x.toFixed(1)}</div>
                    <div style={{ color: palette.textDim }}>cost trend: {d.y >= 0 ? "+" : ""}{d.y.toFixed(0)} mc/d</div>
                    <div style={{ color: palette.textDim }}>token trend: {d.tokenSlope >= 0 ? "+" : ""}{d.tokenSlope.toFixed(0)}/d</div>
                  </div>
                );
              }}
            />
            <Scatter data={points} isAnimationActive={false}>
              {points.map((p, i) => (
                <Cell key={i} fill={p.color} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
        {/* Legend */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingLeft: 16, marginTop: 4 }}>
          {points.map((p) => (
            <span key={p.userId} style={{ fontSize: 11, color: p.color, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
              {p.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── (b) Pairing heatmap grid ─────────────────────────────────────────────────

const BUCKET_LABELS = [
  "00–02", "02–04", "04–06", "06–08", "08–10", "10–12",
  "12–14", "14–16", "16–18", "18–20", "20–22", "22–24",
];

function PairingHeatmapGrid({
  heatmap,
  pairs,
  onSelectPair,
}: {
  heatmap: PairingHeatmapCell[];
  pairs: PairCompatibility[];
  onSelectPair: (pair: PairCompatibility) => void;
}): ReactElement {
  if (pairs.length === 0) {
    return (
      <section style={{ marginBottom: space.x6 }}>
        <SectionHeader title="Pairing heatmap" hint="who was active with whom · 2h UTC buckets" />
        <div style={{ color: palette.textDim, fontSize: 12 }}>Need at least 2 developers.</div>
      </section>
    );
  }

  // Build lookup: (userA, userB, bucket) → coActiveDays
  const lookup = new Map<string, number>();
  for (const cell of heatmap) {
    lookup.set(`${cell.userA}::${cell.userB}::${cell.bucketIndex}`, cell.coActiveDays);
  }

  // Max coActiveDays for color scaling.
  const maxDays = Math.max(...heatmap.map((c) => c.coActiveDays), 1);

  function cellColor(days: number): string {
    if (days === 0) return palette.bgSurface;
    const intensity = Math.min(days / maxDays, 1);
    // Interpolate from dark-surface (#1a1a1f) to cyan (#00e5ff)
    const r = Math.round(0 + intensity * 0);
    const g = Math.round(229 * intensity);
    const b = Math.round(255 * intensity);
    return `rgba(${r}, ${g}, ${b}, ${0.15 + intensity * 0.75})`;
  }

  return (
    <section style={{ marginBottom: space.x6 }}>
      <SectionHeader title="Pairing heatmap" hint="who was active with whom · 2h UTC buckets · click a row for details" />
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: 560 }}>
          <thead>
            <tr>
              <th style={thStyle}>pair</th>
              {BUCKET_LABELS.map((lbl) => (
                <th key={lbl} style={{ ...thStyle, minWidth: 40, fontSize: 10 }}>{lbl}</th>
              ))}
              <th style={thStyle}>score</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair, pi) => {
              const compatPct = Math.round(pair.compositeScore * 100);
              return (
                <tr
                  key={`${pair.userA}-${pair.userB}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectPair(pair)}
                >
                  <td style={{ ...tdStyle, color: pairColor(pi), whiteSpace: "nowrap" }}>
                    {shortId(pair.userA)} / {shortId(pair.userB)}
                  </td>
                  {Array.from({ length: 12 }, (_, bucket) => {
                    const days = lookup.get(`${pair.userA}::${pair.userB}::${bucket}`) ?? 0;
                    return (
                      <td
                        key={bucket}
                        title={`${days}d co-active`}
                        style={{
                          ...tdStyle,
                          background: cellColor(days),
                          textAlign: "center",
                          color: days > 0 ? palette.text : palette.textDim,
                        }}
                      >
                        {days > 0 ? days : ""}
                      </td>
                    );
                  })}
                  <td style={{ ...tdStyle, color: compatPct >= 60 ? palette.green : compatPct >= 30 ? palette.amber : palette.textDim }}>
                    {compatPct}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── (c) Pair detail modal ────────────────────────────────────────────────────

function PairDetailModal({
  pair,
  vectors,
  onClose,
}: {
  pair: PairCompatibility;
  vectors: VelocityVector[];
  onClose: () => void;
}): ReactElement {
  const vA = vectors.find((v) => v.userId === pair.userA);
  const vB = vectors.find((v) => v.userId === pair.userB);

  // Combined cost trend sparkline data (last 7 days, index 0 = most recent → reverse for chart).
  const combinedCosts = Array.from({ length: 7 }, (_, i) => ({
    day: 6 - i,
    cost: ((vA?.costMillicents[i] ?? 0) + (vB?.costMillicents[i] ?? 0)) / 1000, // → cents
  }));

  const overlapPct   = Math.round(pair.overlapPct   * 100);
  const modelAlnPct  = Math.round(pair.modelAlignment * 100);
  const costSimPct   = Math.round(pair.costSimilarity * 100);
  const scorePct     = Math.round(pair.compositeScore  * 100);
  const trendSign    = pair.combinedCostTrendSlope >= 0 ? "+" : "";
  const trendVal     = (pair.combinedCostTrendSlope / 1000).toFixed(2); // mc → cents

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: palette.bgSurface,
        border: `1px solid ${palette.border}`,
        borderRadius: 12,
        padding: 28,
        minWidth: 360,
        maxWidth: 500,
        width: "90%",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: palette.text, fontWeight: 600 }}>
            {shortId(pair.userA)} &amp; {shortId(pair.userB)}
          </h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: palette.textDim, fontSize: 18, cursor: "pointer", lineHeight: 1 }}
            aria-label="close"
          >
            ×
          </button>
        </div>

        {/* Score breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
          <MetricPill label="compatibility" value={`${scorePct}%`} accent={palette.cyan} />
          <MetricPill label="time overlap"  value={`${overlapPct}%`} accent={palette.green} />
          <MetricPill label="model align"   value={`${modelAlnPct}%`} accent={palette.amber} />
          <MetricPill label="cost similarity" value={`${costSimPct}%`} accent="#a78bfa" />
        </div>

        {/* Shared repos */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>
            top shared repos
          </div>
          {pair.sharedRepos.length === 0 ? (
            <div style={{ fontSize: 12, color: palette.textDim }}>No common repo data yet.</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {pair.sharedRepos.map((repo) => (
                <li key={repo} style={{ fontSize: 12, color: palette.text, padding: "3px 0" }}>
                  {repo}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Combined cost trend sparkline */}
        <div>
          <div style={{ fontSize: 11, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>
            combined cost trend (last 7d) · {trendSign}{trendVal}¢/day
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <ScatterChart margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="2 2" stroke={palette.border} />
              <XAxis dataKey="day" type="number" hide />
              <YAxis dataKey="cost" type="number" tick={{ fill: palette.textDim, fontSize: 9 }} width={32} />
              <Scatter data={combinedCosts} fill={palette.cyan} isAnimationActive={false} line={{ stroke: palette.cyan, strokeWidth: 1.5 }} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── Shared micro-components ──────────────────────────────────────────────────

function SectionHeader({ title, hint }: { title: string; hint: string }): ReactElement {
  return (
    <div style={{ marginBottom: 10 }}>
      <span style={{ fontSize: 12, color: palette.text, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{title}</span>
      <span style={{ fontSize: 11, color: palette.textDim, marginLeft: 8 }}>{hint}</span>
    </div>
  );
}

function MetricPill({ label, value, accent }: { label: string; value: string; accent: string }): ReactElement {
  return (
    <div style={{ background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 6, padding: "8px 12px" }}>
      <div style={{ fontSize: 10, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.4px" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function shortId(userId: string): string {
  // Show last 8 chars of UUID for privacy — no email shown.
  return userId.slice(-8);
}

const thStyle: React.CSSProperties = {
  padding: "4px 8px",
  color: palette.textDim,
  textAlign: "left",
  fontWeight: 500,
  borderBottom: `1px solid ${palette.border}`,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: `1px solid ${palette.border}`,
  color: palette.text,
};
