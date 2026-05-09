/**
 * /compare — side-by-side source comparison.
 *
 * URL: /compare?a=claude_code&b=codex&days=30
 *
 * Defaults: a=claude_code, b=codex, days=30.
 *
 * Each column shows the same set of mini-charts for one source:
 *   cost trajectory line, model mix donut, hour-of-day bar chart,
 *   top repos list, latency p50/p95 stat, tool-call mix horizontal bar.
 *
 * TODO: swap ParallelDonuts component once Phase 5 lands.
 * TODO: swap CompareView component once Phase 5 lands.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, subscriptionSourcesFor } from "@/lib/org-db";
import { loadCompare, type ScopeFilter, type CompareSide } from "@/lib/dashboard-data";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { DonutChart, type DonutSlice } from "@/components/charts/DonutChart";
import { HBarChart, type HBarPoint } from "@/components/charts/HBarChart";

import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

// Sources allowed in query params — matches activity_event.source CHECK.
const VALID_SOURCES = [
  "claude_code", "codex", "cursor", "copilot",
  "wakatime", "shell", "git", "ashlr_plugin",
] as const;

type ValidSource = (typeof VALID_SOURCES)[number];

interface SearchParams {
  a?: string;
  b?: string;
  days?: string;
}

function resolveSource(raw: string | undefined, fallback: ValidSource): ValidSource {
  if (raw && VALID_SOURCES.includes(raw as ValidSource)) return raw as ValidSource;
  return fallback;
}

function resolveDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "30", 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  if (n > 90) return 90;
  return n;
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function ComparePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { a: rawA, b: rawB, days: rawDays } = await searchParams;

  // Handle swap: flip A and B via redirect.
  const srcA = resolveSource(rawA, "claude_code");
  const srcB = resolveSource(rawB, "codex");
  const days  = resolveDays(rawDays);

  const org = await primaryOrgForUser(me.id);
  const subscriptionSources = subscriptionSourcesFor(org);

  const scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };

  const data = await loadCompare(me.id, scope, srcA, srcB, days, {
    subscriptionSources,
  });

  // Build swap URL (flips A and B).
  const swapUrl = `/compare?a=${encodeURIComponent(srcB)}&b=${encodeURIComponent(srcA)}&days=${days}`;

  return (
    <DashboardShell>
      <Header me={me} active="compare" />

      {/* Page header + swap button */}
      <div style={{ marginBottom: space.x6 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: space.x2,
        }}>
          <h1 style={{
            fontSize: 20, fontWeight: 600, color: palette.text,
            fontFamily: "var(--font-mono)", margin: 0,
          }}>
            compare sources
          </h1>

          <div style={{ display: "flex", gap: space.x2, alignItems: "center" }}>
            {/* Window selector */}
            {([7, 14, 30, 90] as const).map((d) => (
              <a
                key={d}
                href={`/compare?a=${encodeURIComponent(srcA)}&b=${encodeURIComponent(srcB)}&days=${d}`}
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 4,
                  border: `1px solid ${d === days ? palette.cyan : palette.border}`,
                  color: d === days ? palette.cyan : palette.textDim,
                  textDecoration: "none", fontFamily: "var(--font-mono)",
                }}
              >
                {d}d
              </a>
            ))}

            {/* Swap button */}
            <a
              href={swapUrl}
              style={{
                fontSize: 12, padding: "3px 12px", borderRadius: 4,
                border: `1px solid ${palette.border}`,
                color: palette.textDim, textDecoration: "none",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⇄ swap
            </a>
          </div>
        </div>

        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          last {days} days · subscription-covered sources show rate-card cost as $0
        </p>
      </div>

      {/* Two-column grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: space.x4,
      }}>
        <SideColumn
          side={data.a}
          days={days}
          subscriptionSources={subscriptionSources}
        />
        <SideColumn
          side={data.b}
          days={days}
          subscriptionSources={subscriptionSources}
        />
      </div>
    </DashboardShell>
  );
}

// ─── per-source column ────────────────────────────────────────────────────────

interface SideColumnProps {
  side: CompareSide;
  days: number;
  subscriptionSources: Set<string>;
}

function SideColumn({ side, days, subscriptionSources }: SideColumnProps): ReactElement {
  const isSub = subscriptionSources.has(side.source);
  const costLabel = isSub ? "subscription (rate-card: $0)" : (
    side.totalCostCents != null ? fmtUsd(side.totalCostCents / 100) : "—"
  );

  // Cost trajectory line data — values in whole cents; formatted as dollars-2dp.
  // costCents is integer cents; divide by 100 for dollar display.
  const costLine: LinePoint[] = side.daily.map((d) => ({
    bucket: d.ts.slice(5), // "MM-DD"
    cost:   (d.costCents ?? 0) / 100,
  }));

  // Model mix donut slices
  const modelSlices: DonutSlice[] = side.modelMix.map((m) => ({
    label: m.name,
    value: m.value,
  }));

  // Hour-of-day bar — treat each hour as a "label"
  const hourBars: HBarPoint[] = side.hourOfDay.map((count, h) => ({
    label: `${String(h).padStart(2, "0")}:00`,
    value: count,
  })).filter((p) => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);

  // Tool call horizontal bars
  const toolBars: HBarPoint[] = side.toolCalls.map((t) => ({
    label: t.name,
    value: t.count,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x3 }}>
      {/* Source header card */}
      <Card>
        <div style={{ padding: "12px 16px" }}>
          <div style={{
            display: "flex", alignItems: "baseline",
            justifyContent: "space-between", marginBottom: 8,
          }}>
            <span style={{
              fontSize: 16, fontWeight: 700, color: palette.cyan,
              fontFamily: "var(--font-mono)",
            }}>
              {side.source}
            </span>
            {isSub && (
              <span style={{
                fontSize: 10, color: palette.green, border: `1px solid ${palette.green}`,
                borderRadius: 3, padding: "1px 6px", fontFamily: "var(--font-mono)",
              }}>
                subscription
              </span>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <Stat label="tokens" value={abbrev(side.totalTokens)} />
            <Stat label={`cost (${days}d)`} value={costLabel} />
            <Stat label="p50 latency" value={`${side.latency.p50}ms`} />
          </div>
        </div>
      </Card>

      {/* Cost trajectory */}
      <ChartFrame title="cost / day" hint={`last ${days}d`} accent={palette.cyan}>
        {costLine.length === 0 ? (
          <Empty />
        ) : (
          <LineChart
            data={costLine}
            series={[{ key: "cost", label: "cost (¢)", color: palette.cyan }]}
            yFormat="dollars-2dp"
            valueFormat="dollars-2dp"
            height={160}
          />
        )}
      </ChartFrame>

      {/* Model mix donut */}
      {/* TODO: swap to ParallelDonuts once Phase 5 chart lands */}
      <ChartFrame title="model mix" hint="tokens by model" accent={palette.magenta}>
        {modelSlices.length === 0 ? (
          <Empty />
        ) : (
          <DonutChart
            data={modelSlices}
            valueFormat="abbrev"
            height={180}
          />
        )}
      </ChartFrame>

      {/* Hour-of-day bar chart */}
      <ChartFrame title="hour of day" hint="UTC, event count" accent={palette.amber}>
        {hourBars.length === 0 ? (
          <Empty />
        ) : (
          <HBarChart
            data={hourBars}
            valueFormat="abbrev"
          />
        )}
      </ChartFrame>

      {/* Top repos */}
      <Card>
        <CardHeader title="top repos" hint="by tokens" />
        {side.topRepos.length === 0 ? (
          <Empty />
        ) : (
          <div style={{ padding: "0 16px 12px" }}>
            {side.topRepos.map((r, i) => (
              <div
                key={r.repo}
                style={{
                  display: "flex", justifyContent: "space-between",
                  padding: "5px 0",
                  borderBottom: i < side.topRepos.length - 1
                    ? `1px solid ${palette.border}` : "none",
                }}
              >
                <span style={{ fontSize: 12, color: palette.text, fontFamily: "var(--font-mono)" }}>
                  {r.repo}
                </span>
                <span style={{ fontSize: 12, color: palette.textDim, fontFamily: "var(--font-mono)" }}>
                  {abbrev(r.tokens)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Latency p50 / p95 */}
      <Card>
        <CardHeader title="latency" hint="duration_ms" />
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr",
          gap: 8, padding: "0 16px 16px",
        }}>
          <Stat label="p50" value={`${side.latency.p50}ms`} />
          <Stat label="p95" value={`${side.latency.p95}ms`} />
        </div>
      </Card>

      {/* Tool-call mix */}
      <ChartFrame title="tool calls" hint="top 8 by count" accent={palette.green}>
        {toolBars.length === 0 ? (
          <Empty />
        ) : (
          <HBarChart
            data={toolBars}
            valueFormat="abbrev"
          />
        )}
      </ChartFrame>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <div style={{ fontSize: 10, color: palette.textMute, marginBottom: 2, fontFamily: "var(--font-mono)" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: palette.text, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function Empty(): ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: 80, color: palette.textMute, fontSize: 12,
      fontFamily: "var(--font-mono)",
    }}>
      no data
    </div>
  );
}
