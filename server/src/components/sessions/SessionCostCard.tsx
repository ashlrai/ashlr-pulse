/**
 * SessionCostCard.tsx — client component: cost + token efficiency breakdown
 * card for one session.
 *
 * Shown above the flamegraph on the /sessions/[id] detail page.
 */

"use client";

import type { ReactElement } from "react";
import type { SessionCluster } from "@/lib/session-cluster";
import { Card } from "@/components/ui/Card";
import { palette, space, font } from "@/lib/theme";

interface Props {
  cluster: SessionCluster;
}

function StatItem({ label, value, accent }: { label: string; value: string; accent?: string }): ReactElement {
  return (
    <div style={{ minWidth: 120 }}>
      <div
        style={{
          fontSize: 10,
          color: palette.textMute,
          textTransform: "uppercase",
          letterSpacing: "0.8px",
          fontFamily: font.mono,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: accent ?? palette.text,
          fontFamily: font.mono,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SessionCostCard({ cluster }: Props): ReactElement {
  const costUsd = cluster.totalCost / 100;
  const efficiency = cluster.avgTokensPerMs;

  // Per-tool cost attribution.
  const toolCosts = new Map<string, number>();
  for (const call of cluster.toolChain) {
    toolCosts.set(call.tool, (toolCosts.get(call.tool) ?? 0) + call.cost);
  }
  const topTools = [...toolCosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <Card>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: space.x6,
          marginBottom: space.x5,
        }}
      >
        <StatItem
          label="Total Cost"
          value={`$${costUsd.toFixed(4)}`}
          accent={costUsd > 5 ? palette.red : costUsd > 1 ? palette.amber : palette.green}
        />
        <StatItem
          label="Duration"
          value={fmtDuration(cluster.totalLatency)}
        />
        <StatItem
          label="Total Tokens"
          value={fmtTokens(cluster.totalTokens)}
        />
        <StatItem
          label="Efficiency"
          value={efficiency > 0 ? `${efficiency.toFixed(2)} tok/ms` : "—"}
          accent={palette.cyan}
        />
        <StatItem
          label="Spans"
          value={String(cluster.spanCount)}
        />
        <StatItem
          label="Phases"
          value={String(cluster.phases.length)}
          accent={cluster.phases.length > 0 ? palette.purple : palette.textDim}
        />
      </div>

      {/* Cost by tool */}
      {topTools.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 10,
              color: palette.textMute,
              textTransform: "uppercase",
              letterSpacing: "0.8px",
              fontFamily: font.mono,
              marginBottom: space.x2,
            }}
          >
            Cost Attribution by Tool
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {topTools.map(([tool, cost]) => {
              const pct = cluster.totalCost > 0 ? (cost / cluster.totalCost) * 100 : 0;
              return (
                <div
                  key={tool}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.x2,
                    fontSize: 11,
                    fontFamily: font.mono,
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      color: palette.textDim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tool}
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
                        width: `${pct}%`,
                        height: "100%",
                        background: palette.amber,
                        borderRadius: 3,
                      }}
                    />
                  </div>
                  <div style={{ width: 60, textAlign: "right", color: palette.amber }}>
                    ${(cost / 100).toFixed(4)}
                  </div>
                  <div style={{ width: 36, textAlign: "right", color: palette.textMute }}>
                    {pct.toFixed(0)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
