/**
 * /ask — Ask Pulse: type a question, get a chart.
 *
 * Server-rendered. The form GETs back to this route with `?q=…`,
 * we parse the question via Claude, run the safe DSL query, and
 * render a chart matched to the result shape.
 *
 * No client JS for the core flow — everything is SSR.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { parseQuestion, runQuery, type AskResult } from "@/lib/ask-pulse";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { LineChart } from "@/components/charts/LineChart";
import { HBarChart } from "@/components/charts/HBarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

const SUGGESTIONS = [
  "What did I spend yesterday?",
  "Tokens by repo last week",
  "Hour of day I work most",
  "Top models by cost this month",
  "Cache hit ratio by day",
  "Most-called tools last week",
];

export default async function AskPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const { q } = await searchParams;

  let result: AskResult | null = null;
  let parseError: string | null = null;

  if (q && q.trim().length > 0) {
    const parsed = await parseQuestion(q);
    if (!parsed) {
      parseError =
        "Couldn't parse that question. Try rephrasing — and check that ANTHROPIC_API_KEY is set in the server env if every question fails.";
    } else {
      result = await runQuery(me.id, parsed);
    }
  }

  return (
    <DashboardShell maxWidth={960}>
      <Header me={me} active="ask" />
      <h1 style={pageTitle}>ask pulse</h1>
      <p style={pageSub}>
        natural-language queries against your activity — powered by Claude. answers are server-side and use a constrained DSL (no SQL injection surface).
      </p>

      <form action="/ask" method="GET" style={{ display: "flex", gap: space.x2, marginBottom: space.x4 }}>
        <Input
          name="q"
          type="text"
          required
          defaultValue={q ?? ""}
          placeholder="e.g. tokens by repo last week"
          style={{ flex: 1 }}
        />
        <Button type="submit" variant="primary">ask</Button>
      </form>

      {!q && (
        <Card>
          <CardHeader title="suggestions" hint="click any to run it" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {SUGGESTIONS.map((s) => (
              <a
                key={s}
                href={`/ask?q=${encodeURIComponent(s)}`}
                style={{
                  fontSize: 12, padding: "6px 12px",
                  background: palette.bgRaised,
                  border: `1px solid ${palette.border}`,
                  borderRadius: 999,
                  color: palette.text, textDecoration: "none",
                  transition: "border-color 0.12s ease, color 0.12s ease",
                }}
              >
                {s}
              </a>
            ))}
          </div>
        </Card>
      )}

      {parseError && <Banner variant="warning">{parseError}</Banner>}

      {result && <ResultPanel result={result} />}
    </DashboardShell>
  );
}

function ResultPanel({ result }: { result: AskResult }): ReactElement {
  const { query, rows, chart, summary } = result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
      <Card accent={palette.cyan}>
        <div style={{ fontSize: 11, color: palette.cyan, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 6 }}>
          parsed query
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: palette.textDim }}>
          <Pill k="metric"      v={query.metric} color={palette.green} />
          <Pill k="group by"    v={query.group_by} color={palette.cyan} />
          <Pill k="window"      v={`${query.window_days}d`} color={palette.amber} />
          {query.filter?.source && <Pill k="source" v={query.filter.source} color={palette.purple} />}
          {query.filter?.repo && <Pill k="repo"     v={query.filter.repo}   color={palette.purple} />}
          {query.filter?.model && <Pill k="model"   v={query.filter.model}  color={palette.purple} />}
          <Pill k="sort" v={query.sort ?? "value_desc"} color={palette.textDim} />
        </div>
        <div style={{ marginTop: space.x3, fontSize: 14, color: palette.text }}>
          {summary}
        </div>
      </Card>

      <ChartFrame title={`${query.metric} by ${query.group_by} · last ${query.window_days}d`}>
        {rows.length === 0 ? (
          <div style={{
            height: 180, display: "flex", alignItems: "center", justifyContent: "center",
            color: palette.textMute, fontSize: 12,
            border: `1px dashed ${palette.border}`, borderRadius: 6,
          }}>
            No rows in that window.
          </div>
        ) : chart === "line" ? (
          <LineChart
            data={rows.map((r) => ({ bucket: r.label, value: r.value }))}
            series={[{ key: "value", label: query.metric, color: palette.green }]}
            yFmt={(v) => query.metric === "cost" ? `$${v.toFixed(0)}` : v.toLocaleString()}
            vFmt={(v) => fmtForMetric(query.metric, Number(v))}
          />
        ) : chart === "donut" ? (
          <DonutChart
            data={rows.map((r) => ({ label: r.label, value: r.value }))}
            vFmt={(v) => fmtForMetric(query.metric, Number(v))}
            centerValue={fmtForMetric(query.metric, rows.reduce((a, b) => a + b.value, 0))}
            centerLabel={query.metric}
          />
        ) : (
          <HBarChart
            data={rows.map((r) => ({ label: r.label, value: r.value }))}
            uniformColor={palette.cyan}
            vFmt={(v) => fmtForMetric(query.metric, Number(v))}
          />
        )}
      </ChartFrame>

      <Card>
        <CardHeader title="raw rows" hint={`${rows.length} row${rows.length === 1 ? "" : "s"}`} />
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
              <th style={th}>{query.group_by}</th>
              <th style={{ ...th, textAlign: "right" }}>{query.metric}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                <td style={td}>{r.label}</td>
                <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                  {fmtForMetric(query.metric, r.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Pill({ k, v, color }: { k: string; v: string; color: string }): ReactElement {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 9px",
      background: `${color}10`,
      border: `1px solid ${color}30`,
      borderRadius: 999,
      color, fontSize: 11, letterSpacing: "0.3px",
    }}>
      <span style={{ color: palette.textMute, fontSize: 10 }}>{k}</span>
      {v}
    </span>
  );
}

function fmtForMetric(metric: string, v: number): string {
  if (metric === "cost") return fmtUsd(Math.round(v * 100));
  if (metric === "cache_hit_ratio") return `${(v * 100).toFixed(1)}%`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}k`;
  return v.toLocaleString();
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };
