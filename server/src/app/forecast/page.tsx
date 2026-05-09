/**
 * /forecast — cost projection and budget burn-down.
 *
 * URL: /forecast?days=30
 *
 * Sections:
 *   1. Top:    OLS forecast chart — history (solid) + projection (dashed).
 *              Uses projectForecast() from lib/forecast.ts.
 *   2. Middle: Budget burn-down — text + inline progress bar.
 *              Pulls monthly_budget_usd from org.
 *   3. Bottom: Top cost drivers (model × tool combos with % of spend).
 *
 * TODO: swap to ForecastChart component once Phase 5 chart lands.
 * TODO: swap to BudgetBurndown component once Phase 5 lands.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, subscriptionSourcesFor } from "@/lib/org-db";
import { loadForecast, type ScopeFilter } from "@/lib/dashboard-data";
import {
  projectForecast,
  type SeriesPoint,
  type OlsForecastPoint,
} from "@/lib/forecast";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";

import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { days?: string }

function resolveDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "30", 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  if (n > 90) return 90;
  return n;
}

export default async function ForecastPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { days: rawDays } = await searchParams;
  const days = resolveDays(rawDays);

  const org = await primaryOrgForUser(me.id);
  const subscriptionSources = subscriptionSourcesFor(org);
  const monthlyBudgetUsd = org?.monthly_budget_usd ?? null;

  const scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };

  const data = await loadForecast(me.id, scope, days, monthlyBudgetUsd, {
    subscriptionSources,
  });

  // Build OLS projection from the history series (values are in cents).
  const historySeries: SeriesPoint[] = data.history.map((h) => ({
    ts:    h.ts,
    value: h.value, // cents
  }));

  // Project 30 days into the future from the last history date.
  const HORIZON = 30;
  const projection: OlsForecastPoint[] = projectForecast(historySeries, HORIZON);

  // Build LineChart data: combine history (solid) + projection (dashed).
  // We merge into a single series so the x-axis is continuous.
  // History uses "history" key; projection uses "forecast" key so they
  // render as separate Line elements with different strokeDasharray.
  const allDates = [
    ...historySeries.map((p) => p.ts),
    ...projection.map((p) => p.ts),
  ];

  const lineData: LinePoint[] = allDates.map((ts) => {
    const hPt = historySeries.find((h) => h.ts === ts);
    const fPt = projection.find((f) => f.ts === ts);
    return {
      bucket:   ts.slice(5), // "MM-DD"
      history:  hPt != null ? hPt.value / 100 : undefined as unknown as number,
      forecast: fPt != null ? fPt.value / 100 : undefined as unknown as number,
      lower:    fPt != null ? fPt.lower / 100 : undefined as unknown as number,
      upper:    fPt != null ? fPt.upper / 100 : undefined as unknown as number,
    };
  });

  // Projected month-end spend = spent so far + (daily rate × remaining days).
  const remainingDays = data.daysInMonth - data.daysElapsedInMonth;
  const dailyRateCents = data.daysElapsedInMonth > 0
    ? data.spentThisMonthCents / data.daysElapsedInMonth
    : 0;
  const projectedMonthEndCents = data.spentThisMonthCents + dailyRateCents * remainingDays;

  // Budget progress [0..1] — clamp to 1.0.
  const budgetCents = monthlyBudgetUsd != null ? monthlyBudgetUsd * 100 : null;
  const budgetPct   = budgetCents != null && budgetCents > 0
    ? Math.min(1, data.spentThisMonthCents / budgetCents)
    : null;
  const projPct     = budgetCents != null && budgetCents > 0
    ? Math.min(1, projectedMonthEndCents / budgetCents)
    : null;

  return (
    <DashboardShell>
      <Header me={me} active="forecast" />

      {/* Page header + window picker */}
      <div style={{ marginBottom: space.x6 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: space.x2,
        }}>
          <h1 style={{
            fontSize: 20, fontWeight: 600, color: palette.text,
            fontFamily: "var(--font-mono)", margin: 0,
          }}>
            cost forecast
          </h1>
          <div style={{ display: "flex", gap: space.x2 }}>
            {([14, 30, 60, 90] as const).map((d) => (
              <a
                key={d}
                href={`/forecast?days=${d}`}
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 4,
                  border: `1px solid ${d === days ? palette.cyan : palette.border}`,
                  color: d === days ? palette.cyan : palette.textDim,
                  textDecoration: "none", fontFamily: "var(--font-mono)",
                }}
              >
                {d}d history
              </a>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          OLS linear trend · 90% confidence band · subscription sources contribute $0
        </p>
      </div>

      {/* ── Section 1: Forecast chart ── */}
      {/* TODO: swap to ForecastChart component once Phase 5 chart lands */}
      <div style={{ marginBottom: space.x4 }}>
        <ChartFrame
          title="cost trajectory + 30-day projection"
          hint={`last ${days}d history + 30d OLS forecast`}
          accent={palette.cyan}
          minHeight={260}
        >
          {lineData.length === 0 ? (
            <EmptyState message="no cost data in this window" />
          ) : (
            <LineChart
              data={lineData}
              series={[
                { key: "history",  label: "history",    color: palette.cyan },
                { key: "forecast", label: "projection", color: palette.amber },
              ]}
              yFormat="dollars-2dp"
              valueFormat="dollars-2dp"
              height={260}
            />
          )}
        </ChartFrame>

        {projection.length > 0 && (
          <div style={{
            marginTop: space.x2, padding: `${space.x2}px ${space.x3}px`,
            background: palette.bgRaised,
            border: `1px solid ${palette.border}`,
            borderRadius: 6, fontSize: 12,
            color: palette.textDim, fontFamily: "var(--font-mono)",
            display: "flex", gap: space.x6,
          }}>
            <span>
              projected day +30:{" "}
              <strong style={{ color: palette.amber }}>
                {fmtUsd(Math.round(projection[projection.length - 1].value))}
              </strong>
              /day
            </span>
            <span>
              90% band:{" "}
              <strong style={{ color: palette.text }}>
                {fmtUsd(Math.round(projection[projection.length - 1].lower))}
                {" – "}
                {fmtUsd(Math.round(projection[projection.length - 1].upper))}
              </strong>
            </span>
          </div>
        )}
      </div>

      {/* ── Section 2: Budget burn-down ── */}
      {/* TODO: swap to BudgetBurndown component once Phase 5 lands */}
      <div style={{ marginBottom: space.x4 }}>
        <Card>
          <CardHeader
            title="monthly budget"
            hint={`day ${data.daysElapsedInMonth} of ${data.daysInMonth}`}
          />
          <div style={{ padding: `0 ${space.x3}px ${space.x3}px` }}>
            {budgetCents == null ? (
              <p style={{ fontSize: 13, color: palette.textMute, margin: 0 }}>
                no monthly budget set ·{" "}
                <a href="/settings" style={{ color: palette.cyan }}>
                  configure in settings →
                </a>
              </p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: palette.text, margin: `0 0 ${space.x2}px` }}>
                  <strong style={{ color: palette.cyan }}>
                    {fmtUsd(data.spentThisMonthCents)}
                  </strong>
                  {" / "}
                  <strong>{fmtUsd(budgetCents)}</strong>
                  {" on day "}
                  <strong>{data.daysElapsedInMonth}</strong>
                  {" of "}
                  <strong>{data.daysInMonth}</strong>
                  {" — projected "}
                  <strong style={{
                    color: projectedMonthEndCents > budgetCents
                      ? palette.red
                      : palette.green,
                  }}>
                    {fmtUsd(Math.round(projectedMonthEndCents))}
                  </strong>
                  {" by month-end"}
                </p>

                {/* Progress bars: current + projected */}
                <ProgressBar
                  pct={budgetPct ?? 0}
                  color={palette.cyan}
                  label="spent"
                />
                {projPct != null && (
                  <ProgressBar
                    pct={projPct}
                    color={projectedMonthEndCents > budgetCents ? palette.red : palette.amber}
                    label="projected"
                  />
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* ── Section 3: Top cost drivers ── */}
      <div>
        <Card>
          <CardHeader
            title="top cost drivers"
            hint={`model × tool · last ${days}d`}
          />
          {data.topDrivers.length === 0 ? (
            <EmptyState message="no cost data in this window" />
          ) : (
            <div style={{ padding: `0 ${space.x3}px ${space.x3}px` }}>
              {data.topDrivers.map((d, i) => (
                <div
                  key={d.label}
                  style={{
                    display: "flex", alignItems: "center",
                    gap: space.x3, padding: `${space.x1}px 0`,
                    borderBottom: i < data.topDrivers.length - 1
                      ? `1px solid ${palette.border}` : "none",
                  }}
                >
                  {/* Inline bar */}
                  <div style={{
                    flex: "0 0 120px", height: 6,
                    background: palette.bgRaised, borderRadius: 3, overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${d.pctOfSpend}%`,
                      height: "100%",
                      background: palette.cyan,
                      borderRadius: 3,
                    }} />
                  </div>
                  <span style={{
                    flex: 1, fontSize: 12, color: palette.text,
                    fontFamily: "var(--font-mono)",
                  }}>
                    {d.label}
                  </span>
                  <span style={{
                    fontSize: 12, color: palette.amber,
                    fontFamily: "var(--font-mono)", fontWeight: 600,
                  }}>
                    {d.pctOfSpend.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </DashboardShell>
  );
}

// ─── small helpers ────────────────────────────────────────────────────────────

function ProgressBar({
  pct, color, label,
}: { pct: number; color: string; label: string }): ReactElement {
  const pctClamped = Math.min(1, Math.max(0, pct));
  return (
    <div style={{ marginBottom: space.x1 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: 10, color: palette.textMute, marginBottom: 3,
        fontFamily: "var(--font-mono)",
      }}>
        <span>{label}</span>
        <span>{(pctClamped * 100).toFixed(1)}%</span>
      </div>
      <div style={{
        height: 8, background: palette.bgRaised,
        borderRadius: 4, overflow: "hidden",
        border: `1px solid ${palette.border}`,
      }}>
        <div style={{
          width: `${pctClamped * 100}%`,
          height: "100%",
          background: color,
          borderRadius: 4,
          transition: "width 0.3s ease",
        }} />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }): ReactElement {
  return (
    <div style={{
      padding: space.x4,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: palette.textMute, fontSize: 12, fontFamily: "var(--font-mono)",
    }}>
      {message}
    </div>
  );
}
