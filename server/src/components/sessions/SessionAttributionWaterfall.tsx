/**
 * SessionAttributionWaterfall.tsx — client component: cost attribution waterfall
 * for a single session.
 *
 * Renders:
 *   1. Stacked bar chart (Recharts BarChart) — cost by phase, stacked per tool.
 *   2. Top-5 most expensive tool calls table with tooltip details.
 *   3. Efficiency outlier callout (expensive-but-low-token calls).
 *   4. CSV download button.
 *
 * Privacy floor: only metadata (tool names, latencies, tokens, cost).
 * No code, prompts, or LLM output text ever appears here.
 */

"use client";

import type { ReactElement } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space, font, chartColors } from "@/lib/theme";
import type {
  SessionAttributionPayload,
  AttributedToolCall,
  PhaseAggregate,
  SessionPhase,
} from "@/lib/session-attribution";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  payload: SessionAttributionPayload;
}

// ── Phase colors ──────────────────────────────────────────────────────────────

const PHASE_COLOR: Record<SessionPhase, string> = {
  setup:       palette.textDim,
  exploration: palette.cyan,
  execution:   palette.green,
  review:      palette.purple,
};

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface BarTooltipPayload {
  name: string;
  value: number;
  fill: string;
}

function PhaseTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: BarTooltipPayload[];
  label?: string;
}): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div
      style={{
        background: palette.bgSurface,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: `${space.x1}px ${space.x2}px`,
        fontFamily: font.mono,
        fontSize: 11,
      }}
    >
      <div style={{ color: palette.textDim, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 16, color: p.fill }}>
          <span>{p.name}</span>
          <span>${(p.value / 100).toFixed(4)}</span>
        </div>
      ))}
      <div
        style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: `1px solid ${palette.border}`,
          color: palette.text,
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <span>total</span>
        <span>${(total / 100).toFixed(4)}</span>
      </div>
    </div>
  );
}

// ── Per-call tooltip ──────────────────────────────────────────────────────────

function CallTooltip({ call }: { call: AttributedToolCall }): ReactElement {
  return (
    <div
      style={{
        background: palette.bgSurface,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: `${space.x1}px ${space.x2}px`,
        fontFamily: font.mono,
        fontSize: 10,
        lineHeight: 1.6,
        maxWidth: 280,
      }}
    >
      <div style={{ color: palette.text, fontWeight: 600, marginBottom: 4 }}>{call.tool}</div>
      {call.model && <div style={{ color: palette.cyan }}>model: {call.model}</div>}
      {call.repo && <div style={{ color: palette.textDim }}>repo: {call.repo}</div>}
      <div style={{ color: palette.amber }}>cost: ${call.costUsd.toFixed(6)}</div>
      <div style={{ color: palette.textDim }}>
        tokens: {call.tokensIn.toLocaleString()} in / {call.tokensOut.toLocaleString()} out
      </div>
      <div style={{ color: palette.textDim }}>duration: {call.durationMs}ms</div>
      {call.costPerToken !== null && (
        <div style={{ color: palette.textDim }}>
          cost/token: ${call.costPerToken.toExponential(3)}
        </div>
      )}
      <div
        style={{
          marginTop: 4,
          color: PHASE_COLOR[call.phase],
          textTransform: "uppercase",
          fontSize: 9,
          letterSpacing: "0.8px",
        }}
      >
        {call.phase}
      </div>
    </div>
  );
}

// ── Stacked bar data builder ──────────────────────────────────────────────────

/**
 * Build data for the stacked bar chart.
 * Each bar represents one phase; segments are the distinct tool types
 * with cost (in cents) as the value (Recharts uses raw numbers).
 *
 * We return one data point per phase with tool costs as keyed properties,
 * plus a sorted list of unique tool keys for rendering the Bar layers.
 */
function buildChartData(
  phaseAggregates: PhaseAggregate[],
  toolCalls: AttributedToolCall[],
): { data: Record<string, number | string>[]; toolKeys: string[] } {
  // Collect all unique tools and their total cost per phase.
  const toolSet = new Set<string>();
  const phaseTool = new Map<string, Map<string, number>>();

  for (const call of toolCalls) {
    toolSet.add(call.tool);
    const key = call.phase;
    if (!phaseTool.has(key)) phaseTool.set(key, new Map());
    const toolMap = phaseTool.get(key)!;
    toolMap.set(call.tool, (toolMap.get(call.tool) ?? 0) + call.costUsd * 100); // cents
  }

  // Sort tool keys by total cost descending (most expensive segments first).
  const toolTotals = new Map<string, number>();
  for (const [, toolMap] of phaseTool) {
    for (const [tool, cost] of toolMap) {
      toolTotals.set(tool, (toolTotals.get(tool) ?? 0) + cost);
    }
  }
  const toolKeys = [...toolSet].sort((a, b) => (toolTotals.get(b) ?? 0) - (toolTotals.get(a) ?? 0));

  // Build one data point per phase.
  const PHASES: SessionPhase[] = ["setup", "exploration", "execution", "review"];
  const data: Record<string, number | string>[] = PHASES
    .filter((p) => phaseAggregates.find((pa) => pa.phase === p && pa.calls > 0))
    .map((phase) => {
      const row: Record<string, number | string> = { phase };
      const toolMap = phaseTool.get(phase) ?? new Map();
      for (const tool of toolKeys) {
        row[tool] = toolMap.get(tool) ?? 0;
      }
      return row;
    });

  return { data, toolKeys };
}

// ── CSV download ──────────────────────────────────────────────────────────────

function downloadCsv(sessionId: string): void {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/attribution?format=csv`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-attribution-${sessionId.slice(0, 8)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Main component ────────────────────────────────────────────────────────────

export function SessionAttributionWaterfall({ sessionId, payload }: Props): ReactElement {
  const { data: chartData, toolKeys } = buildChartData(
    payload.phaseAggregates,
    payload.toolCalls,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

      {/* ── Stacked bar chart ────────────────────────────────────────────────── */}
      <Card accent={palette.amber}>
        <CardHeader
          title="Cost by Phase"
          hint="stacked by tool type — hover segments for detail"
          right={
            <button
              onClick={() => downloadCsv(sessionId)}
              style={{
                fontSize: 11,
                fontFamily: font.mono,
                color: palette.cyan,
                background: "none",
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              ↓ CSV
            </button>
          }
        />
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
              <XAxis
                dataKey="phase"
                tick={{ fill: palette.textDim, fontSize: 10, fontFamily: font.mono }}
                axisLine={{ stroke: palette.border }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `$${(Number(v) / 100).toFixed(3)}`}
                tick={{ fill: palette.textDim, fontSize: 9, fontFamily: font.mono }}
                axisLine={{ stroke: palette.border }}
                tickLine={false}
                width={60}
              />
              <Tooltip content={<PhaseTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Legend
                wrapperStyle={{ fontSize: 10, fontFamily: font.mono, color: palette.textDim }}
              />
              {toolKeys.map((tool, i) => (
                <Bar key={tool} dataKey={tool} stackId="phase" fill={chartColors[i % chartColors.length]}>
                  {chartData.map((entry, j) => (
                    <Cell key={`cell-${j}`} fill={chartColors[i % chartColors.length]} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* ── Phase summary row ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: space.x3, flexWrap: "wrap" }}>
        {payload.phaseAggregates
          .filter((pa) => pa.calls > 0)
          .map((pa) => (
            <div
              key={pa.phase}
              style={{
                flex: "1 1 140px",
                background: palette.bgSurface,
                border: `1px solid ${palette.border}`,
                borderTop: `2px solid ${PHASE_COLOR[pa.phase]}`,
                borderRadius: 6,
                padding: `${space.x1}px ${space.x2}px`,
                fontFamily: font.mono,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: PHASE_COLOR[pa.phase],
                  textTransform: "uppercase",
                  letterSpacing: "0.8px",
                  marginBottom: 4,
                }}
              >
                {pa.phase}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: palette.text }}>
                ${pa.totalCostUsd.toFixed(4)}
              </div>
              <div style={{ fontSize: 10, color: palette.textDim, marginTop: 2 }}>
                {pa.calls} calls · {(pa.costShare * 100).toFixed(0)}%
              </div>
            </div>
          ))}
      </div>

      {/* ── Top-5 cost calls ─────────────────────────────────────────────────── */}
      {payload.topCostCalls.length > 0 && (
        <Card>
          <CardHeader title="Top Cost Tool Calls" hint="top 5 by spend — hover for detail" />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {payload.topCostCalls.map((call, rank) => (
              <TopCallRow key={call.index} call={call} rank={rank + 1} totalCostUsd={payload.totalCostUsd} />
            ))}
          </div>
        </Card>
      )}

      {/* ── Efficiency outliers ──────────────────────────────────────────────── */}
      {payload.efficiencyOutliers.length > 0 && (
        <Card accent={palette.red}>
          <CardHeader
            title="Cost Efficiency Outliers"
            hint="high cost-per-token + low total tokens — investigate these"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {payload.efficiencyOutliers.slice(0, 5).map((call) => (
              <OutlierRow key={call.index} call={call} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TopCallRow({
  call,
  rank,
  totalCostUsd,
}: {
  call: AttributedToolCall;
  rank: number;
  totalCostUsd: number;
}): ReactElement {
  const pct = totalCostUsd > 0 ? (call.costUsd / totalCostUsd) * 100 : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.x2,
        fontFamily: font.mono,
        fontSize: 11,
        padding: "3px 0",
      }}
      title={`model: ${call.model ?? "—"} · repo: ${call.repo ?? "—"} · ${call.durationMs}ms · ${call.totalTokens} tokens`}
    >
      <div style={{ width: 18, color: palette.textMute, textAlign: "right" }}>#{rank}</div>
      <div style={{ width: 64, color: palette.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {call.tool}
      </div>
      <div
        style={{
          flex: 1,
          height: 6,
          background: palette.bgRaised,
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(pct, 100)}%`,
            height: "100%",
            background: palette.amber,
            borderRadius: 3,
          }}
        />
      </div>
      <div style={{ width: 70, textAlign: "right", color: palette.amber }}>
        ${call.costUsd.toFixed(4)}
      </div>
      <div style={{ width: 36, textAlign: "right", color: palette.textMute }}>
        {pct.toFixed(0)}%
      </div>
      <div
        style={{
          width: 70,
          textAlign: "right",
          color: PHASE_COLOR[call.phase],
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.6px",
        }}
      >
        {call.phase}
      </div>
    </div>
  );
}

function OutlierRow({ call }: { call: AttributedToolCall }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.x2,
        fontFamily: font.mono,
        fontSize: 11,
        padding: "3px 0",
        color: palette.red,
      }}
      title={`cost/token: ${call.costPerToken?.toExponential(3)} · tokens: ${call.totalTokens} · model: ${call.model ?? "—"}`}
    >
      <div style={{ width: 24, color: palette.red }}>⚠</div>
      <div style={{ width: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {call.tool}
      </div>
      <div style={{ color: palette.textDim }}>
        cost: <span style={{ color: palette.red }}>${call.costUsd.toFixed(4)}</span>
      </div>
      <div style={{ color: palette.textDim }}>
        tokens: <span style={{ color: palette.text }}>{call.totalTokens}</span>
      </div>
      {call.costPerToken !== null && (
        <div style={{ color: palette.textDim }}>
          $/tok: <span style={{ color: palette.red }}>{call.costPerToken.toExponential(3)}</span>
        </div>
      )}
      {call.model && (
        <div style={{ color: palette.textDim, fontSize: 9 }}>{call.model}</div>
      )}
    </div>
  );
}
