/**
 * DeltaStatCard.tsx — stat card with delta badge and 7-bar mini sparkline.
 *
 * Server-renderable: sparkline is pure SVG, no Recharts needed.
 * The delta badge color communicates direction at a glance without
 * requiring the user to parse numbers.
 */

import type { ReactElement } from "react";
import { palette, cardStyle, radius } from "@/lib/theme";

interface Delta {
  pct: number;
  direction: "up" | "down" | "flat";
}

interface Props {
  label: string;
  value: string;
  sub?: string;
  delta?: Delta;
  sparkline?: number[];
}

function deltaColor(dir: Delta["direction"]): string {
  if (dir === "up")   return palette.green;
  if (dir === "down") return palette.red;
  return palette.textDim;
}

function deltaArrow(dir: Delta["direction"]): string {
  if (dir === "up")   return "↑";
  if (dir === "down") return "↓";
  return "→";
}

function MiniSparkline({ values }: { values: number[] }): ReactElement {
  const w = 56, h = 24, barW = 5, gap = 2;
  const max = Math.max(...values, 1);
  return (
    <svg width={w} height={h} style={{ display: "block", flexShrink: 0 }}>
      {values.map((v, i) => {
        const barH = Math.max(2, Math.round((v / max) * h));
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={h - barH}
            width={barW}
            height={barH}
            rx={1}
            fill={palette.green}
            fillOpacity={0.55 + 0.45 * (v / max)}
          />
        );
      })}
    </svg>
  );
}

export function DeltaStatCard({ label, value, sub, delta, sparkline }: Props): ReactElement {
  const bars = (sparkline ?? []).slice(-7);

  return (
    <div
      style={{
        ...cardStyle(),
        padding:        "16px 18px",
        display:        "flex",
        flexDirection:  "column",
        gap:            6,
        minWidth:       140,
      }}
    >
      {/* Label row */}
      <div
        style={{
          fontSize:      10,
          color:         palette.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.7px",
          fontFamily:    "var(--font-mono), monospace",
        }}
      >
        {label}
      </div>

      {/* Value + sparkline row */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div
            style={{
              fontSize:           24,
              fontWeight:         600,
              color:              palette.text,
              fontVariantNumeric: "tabular-nums",
              letterSpacing:      "-0.5px",
              lineHeight:         1.1,
            }}
          >
            {value}
          </div>
          {sub && (
            <div style={{ fontSize: 11, color: palette.textDim, marginTop: 3 }}>{sub}</div>
          )}
        </div>
        {bars.length > 0 && <MiniSparkline values={bars} />}
      </div>

      {/* Delta badge */}
      {delta && (
        <div
          style={{
            display:       "inline-flex",
            alignItems:    "center",
            gap:           4,
            fontSize:      11,
            fontFamily:    "var(--font-mono), monospace",
            color:         deltaColor(delta.direction),
            background:    `${deltaColor(delta.direction)}18`,
            borderRadius:  radius.sm,
            padding:       "2px 6px",
            alignSelf:     "flex-start",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {deltaArrow(delta.direction)} {delta.pct > 0 ? "+" : ""}{delta.pct.toFixed(1)}% vs yesterday
        </div>
      )}
    </div>
  );
}
