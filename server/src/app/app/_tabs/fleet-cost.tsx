"use client";
/**
 * fleet-cost.tsx — Realtime cost-impact dashboard for fleet overhead.
 *
 * Displays peer-safe team cost metrics refreshed every 60 s:
 *   • StatCard grid: "Your cost today", "Team average", "Your 7d trend"
 *   • Dual-axis LineChart: your daily cost vs rolling team average (sparkline)
 *   • User table sorted by cost-per-event, column for cost-per-token,
 *     peer-share scoped so viewers only see granted repos
 *   • Tooltip on "peer divergence" metric explaining low/medium/high bands
 *
 * Privacy floor: all values are aggregate numeric — no prompts, code, or
 * content ever displayed. Reads from /api/fleet/cost-impact.
 *
 * Realtime: subscribes to /api/app/live SSE; on "activity" events with
 * cost-impact fields it nudges the local state optimistically before the
 * next 60-second poll.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactElement, CSSProperties } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { palette, space } from "@/lib/theme";
import type { OrgCostImpact, UserCostImpact, ModelDriftEntry } from "@/lib/fleet-cost-impact";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MC_PER_DOLLAR = 100_000; // millicents per dollar

function fmtDollars(mc: number): string {
  const dollars = mc / MC_PER_DOLLAR;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  const cents = mc / 1000;
  if (cents >= 0.01) return `${cents.toFixed(2)}¢`;
  return `${mc.toLocaleString()} mc`;
}

function fmtRatio(ratio: number): string {
  return `${ratio.toFixed(2)}×`;
}

function severityColor(sev: "low" | "medium" | "high" | undefined): string {
  if (sev === "high")   return "#f87171"; // red-400
  if (sev === "medium") return palette.amber;
  return palette.green;
}

function trendLabel(costs: number[]): string {
  if (costs.length < 2) return "—";
  const recent = costs.slice(-3).reduce((s, c) => s + c, 0) / 3;
  const prior  = costs.slice(0, 3).reduce((s, c) => s + c, 0) / 3;
  if (prior === 0) return recent > 0 ? "↑" : "—";
  const pct = ((recent - prior) / prior) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Divergence tooltip content
// ---------------------------------------------------------------------------

const DIVERGENCE_TOOLTIP = `Peer divergence measures how your cost-per-event compares to the team average:
  • Low  (< 3×):  within normal range
  • Medium (3–5×): elevated — check for expensive models or long contexts
  • High  (> 5×):  significant outlier — review agent configuration`;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /** Current viewer's user ID — used to highlight "your" row. */
  currentUserId?: string;
  /** Rolling window in days (matches the dashboard window selector). */
  windowDays?: number;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FleetCostTab({ currentUserId, windowDays = 7 }: Props): ReactElement {
  const [data, setData]       = useState<OrgCostImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/fleet/cost-impact?win=${windowDays}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json() as OrgCostImpact);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load fleet cost data");
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  // Initial load + 60 s refresh.
  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => { void load(); }, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  // SSE subscription: optimistically update cost fields on "activity" events.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const es = new EventSource("/api/app/live");

    es.addEventListener("activity", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as {
          fleet_owner?: string | null;
          cost_millicents?: number | null;
          user_cost_millicents?: number;
          team_avg_millicents?: number;
          peer_divergence_ratio?: number;
          peer_divergence_severity?: "low" | "medium" | "high";
        };
        // If this event carries cost-impact fields, update the team average.
        if (
          payload.team_avg_millicents !== undefined &&
          payload.team_avg_millicents > 0
        ) {
          setData((prev) => {
            if (!prev) return prev;
            return { ...prev, teamAvgDailyMillicents: payload.team_avg_millicents! };
          });
        }
      } catch {
        // Ignore malformed events.
      }
    });

    return () => { es.close(); };
  }, []);

  if (loading) {
    return (
      <div style={{ marginTop: space.x4, color: palette.textDim, fontSize: 13 }}>
        Loading fleet cost data…
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

  if (!data || data.users.length === 0) {
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
        No fleet cost data for the selected window. Ensure peer-share grants are active.
      </div>
    );
  }

  const myData = data.users.find((u) => u.userId === currentUserId);
  const teamAvg = data.teamAvgDailyMillicents;
  const myDaily = myData?.dailyAvgMillicents ?? 0;
  const myTrend = myData ? trendLabel(myData.dailyCosts) : "—";

  return (
    <div style={{ marginTop: space.x4 }}>

      {/* ── Stat cards ─────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: space.x3, marginBottom: space.x4 }}>
        <StatCard
          label="Your cost today"
          value={fmtDollars(myData?.dailyCosts.at(-1) ?? 0)}
          accent={palette.cyan}
        />
        <StatCard
          label="Team average / day"
          value={fmtDollars(teamAvg)}
          accent={palette.green}
        />
        <StatCard
          label={`Your ${windowDays}d trend`}
          value={myTrend}
          hint={`avg ${fmtDollars(myDaily)}/day`}
          accent={myDaily > teamAvg * 1.5 ? "#f87171" : palette.amber}
        />
        <StatCard
          label="Team members"
          value={String(data.users.length)}
          accent={palette.textDim}
        />
      </div>

      {/* ── Sparkline: your cost vs team avg ────────────────────────────── */}
      {myData && (
        <CostSparkline
          userCosts={myData.dailyCosts}
          teamAvg={teamAvg}
          windowDays={windowDays}
        />
      )}

      {/* ── User cost table ──────────────────────────────────────────────── */}
      <UserCostTable
        users={data.users}
        teamAvg={teamAvg}
        currentUserId={currentUserId}
      />

      {/* ── Model drift ──────────────────────────────────────────────────── */}
      {data.modelDrift.length > 0 && (
        <ModelDriftSection drift={data.modelDrift} />
      )}

      <div style={{ marginTop: space.x3, fontSize: 11, color: palette.textMute }}>
        Refreshed every 60 s · computed at {new Date(data.computedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

function StatCard({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent: string }): ReactElement {
  return (
    <div style={{
      background: palette.bgSurface,
      border: `1px solid ${palette.border}`,
      borderRadius: 8,
      padding: "14px 16px",
    }}>
      <div style={{ fontSize: 10, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: palette.textMute, marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CostSparkline — dual-axis LineChart (user daily cost vs team avg)
// ---------------------------------------------------------------------------

function CostSparkline({
  userCosts, teamAvg, windowDays,
}: { userCosts: number[]; teamAvg: number; windowDays: number }): ReactElement {
  const points = userCosts.map((cost, i) => ({
    day: `d-${windowDays - 1 - i}`,
    you: Number((cost / MC_PER_DOLLAR).toFixed(4)),
    avg: Number((teamAvg / MC_PER_DOLLAR).toFixed(4)),
  })).reverse();

  return (
    <div style={{
      background: palette.bgSurface,
      border: `1px solid ${palette.border}`,
      borderRadius: 8,
      padding: "14px 16px",
      marginBottom: space.x4,
    }}>
      <div style={{ fontSize: 11, color: palette.textDim, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>
        Daily cost — you vs team average ({windowDays}d)
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={points} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={palette.border} />
          <XAxis dataKey="day" tick={{ fill: palette.textDim, fontSize: 9 }} />
          <YAxis
            yAxisId="left"
            tick={{ fill: palette.textDim, fontSize: 9 }}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            width={48}
          />
          <ReTooltip
            contentStyle={{ background: palette.bgSurface, border: `1px solid ${palette.border}`, fontSize: 11 }}
            formatter={(value: unknown, name: unknown) => [`$${Number(value).toFixed(4)}`, String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: palette.textDim }} />
          <Line yAxisId="left" type="monotone" dataKey="you"  stroke={palette.cyan}   strokeWidth={2} dot={false} name="you" isAnimationActive={false} />
          <Line yAxisId="left" type="monotone" dataKey="avg"  stroke={palette.amber}  strokeWidth={1} dot={false} name="team avg" strokeDasharray="4 2" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserCostTable
// ---------------------------------------------------------------------------

const th: CSSProperties = {
  padding: "5px 10px",
  textAlign: "left",
  color: palette.textDim,
  fontWeight: 500,
  fontSize: 11,
  borderBottom: `1px solid ${palette.border}`,
  whiteSpace: "nowrap",
};

const td: CSSProperties = {
  padding: "5px 10px",
  fontSize: 12,
  color: palette.text,
  borderBottom: `1px dashed ${palette.border}`,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

function UserCostTable({
  users, teamAvg, currentUserId,
}: { users: UserCostImpact[]; teamAvg: number; currentUserId?: string }): ReactElement {
  return (
    <div style={{ marginBottom: space.x4, overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: palette.text, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          cost by user
        </span>
        <DivergenceInfo />
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={th}>user</th>
            <th style={{ ...th, textAlign: "right" }}>daily avg</th>
            <th style={{ ...th, textAlign: "right" }}>cost/event</th>
            <th style={{ ...th, textAlign: "right" }}>cost/token</th>
            <th style={{ ...th, textAlign: "right" }}>vs team</th>
            <th style={{ ...th, textAlign: "center" }}>divergence</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const ratio = teamAvg > 0 ? u.dailyAvgMillicents / teamAvg : 1;
            const sev: "low" | "medium" | "high" =
              ratio >= 4.99 ? "high" : ratio >= 2.99 ? "medium" : "low";
            const isMe = u.userId === currentUserId;
            return (
              <tr
                key={u.userId}
                style={{ background: isMe ? "rgba(0,229,255,0.04)" : undefined }}
              >
                <td style={{ ...td, color: isMe ? palette.cyan : palette.text, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {shortId(u.userId)}{isMe ? " (you)" : ""}
                </td>
                <td style={{ ...td, textAlign: "right" }}>{fmtDollars(u.dailyAvgMillicents)}</td>
                <td style={{ ...td, textAlign: "right" }}>{u.costPerEvent > 0 ? fmtDollars(u.costPerEvent) : "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{u.costPerToken > 0 ? `${(u.costPerToken * 1000).toFixed(3)} mc/k` : "—"}</td>
                <td style={{ ...td, textAlign: "right", color: ratio > 1.5 ? "#f87171" : ratio < 0.7 ? palette.green : palette.textDim }}>
                  {fmtRatio(ratio)}
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <SeverityBadge severity={sev} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelDriftSection
// ---------------------------------------------------------------------------

function ModelDriftSection({ drift }: { drift: ModelDriftEntry[] }): ReactElement {
  return (
    <div style={{ marginBottom: space.x4 }}>
      <div style={{ fontSize: 11, color: palette.text, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
        Model preference drift (this week vs last)
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={th}>model</th>
            <th style={{ ...th, textAlign: "right" }}>this week</th>
            <th style={{ ...th, textAlign: "right" }}>last week</th>
            <th style={{ ...th, textAlign: "right" }}>drift</th>
            <th style={{ ...th, width: "25%" }}></th>
          </tr>
        </thead>
        <tbody>
          {drift.map((m) => {
            const driftColor = m.driftPct > 5 ? palette.cyan : m.driftPct < -5 ? palette.textMute : palette.textDim;
            return (
              <tr key={m.model}>
                <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: 11, color: palette.text }}>{m.model || "(unknown)"}</td>
                <td style={{ ...td, textAlign: "right" }}>{(m.shareThisWeek * 100).toFixed(1)}%</td>
                <td style={{ ...td, textAlign: "right", color: palette.textDim }}>{(m.shareLastWeek * 100).toFixed(1)}%</td>
                <td style={{ ...td, textAlign: "right", color: driftColor }}>
                  {m.driftPct >= 0 ? "+" : ""}{m.driftPct.toFixed(1)}pp
                </td>
                <td style={td}>
                  <div style={{ height: 5, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.min(100, m.shareThisWeek * 100)}%`,
                      background: palette.cyan,
                      transition: "width 0.4s ease",
                    }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SeverityBadge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: "low" | "medium" | "high" }): ReactElement {
  const color = severityColor(severity);
  return (
    <span style={{
      fontSize: 10,
      color,
      background: `${color}22`,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: "2px 6px",
      textTransform: "uppercase",
      letterSpacing: "0.4px",
      fontWeight: 600,
    }}>
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DivergenceInfo — tooltip explaining severity bands
// ---------------------------------------------------------------------------

function DivergenceInfo(): ReactElement {
  const [show, setShow] = useState(false);

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        aria-label="Peer divergence explanation"
        style={{
          background: "none",
          border: `1px solid ${palette.border}`,
          color: palette.textDim,
          borderRadius: "50%",
          width: 16,
          height: 16,
          fontSize: 10,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
          padding: 0,
        }}
      >
        ?
      </button>
      {show && (
        <div style={{
          position: "absolute",
          top: 20,
          left: 0,
          zIndex: 100,
          background: palette.bgSurface,
          border: `1px solid ${palette.border}`,
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 11,
          color: palette.textDim,
          whiteSpace: "pre-line",
          lineHeight: 1.6,
          minWidth: 320,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}>
          {DIVERGENCE_TOOLTIP}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(userId: string): string {
  return userId.slice(-8);
}
