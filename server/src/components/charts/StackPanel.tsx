/**
 * StackPanel.tsx — horizontal row of per-source mini-cards.
 *
 * Server-renderable: all output is static HTML + SVG. Each card shows
 * cost (or subscription badge), tokens, top model, top repo, and a
 * 7-day sparkline bar chart. Useful as an at-a-glance source summary
 * below the StackedAreaChart.
 */

import type { ReactElement } from "react";
import { palette, cardStyle, sourceColor, radius } from "@/lib/theme";

interface StackItem {
  source:       string;
  /** null means subscription mode — display "$0 (sub)" */
  costCents:    number | null;
  tokens:       number;
  topModel:     string | null;
  topRepo:      string | null;
  sparkline:    number[];
  subscription: boolean;
}

interface Props {
  items: StackItem[];
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function MiniBars({ values, color }: { values: number[]; color: string }): ReactElement {
  const bars = values.slice(-7);
  const max  = Math.max(...bars, 1);
  const w = 7, h = 20, gap = 2;
  const totalW = bars.length * (w + gap) - gap;
  return (
    <svg width={totalW} height={h} style={{ display: "block" }}>
      {bars.map((v, i) => {
        const bh = Math.max(2, Math.round((v / max) * h));
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={1}
            fill={color}
            fillOpacity={0.5 + 0.5 * (v / max)}
          />
        );
      })}
    </svg>
  );
}

function SourceCard({ item }: { item: StackItem }): ReactElement {
  const color = sourceColor[item.source] ?? palette.textDim;
  const costLabel = item.subscription
    ? "$0 (sub)"
    : item.costCents == null
      ? "—"
      : `$${(item.costCents / 100).toFixed(2)}`;

  return (
    <div
      style={{
        ...cardStyle(),
        padding:       "12px 14px",
        display:       "flex",
        flexDirection: "column",
        gap:           8,
        minWidth:      148,
        flex:          "1 1 148px",
        borderTop:     `2px solid ${color}`,
      }}
    >
      {/* Source name */}
      <div
        style={{
          fontSize:      10,
          textTransform: "uppercase",
          letterSpacing: "0.7px",
          color,
          fontFamily:    "var(--font-mono), monospace",
          fontWeight:    600,
        }}
      >
        {item.source.replace(/_/g, " ")}
      </div>

      {/* Cost */}
      <div
        style={{
          fontSize:           18,
          fontWeight:         600,
          color:              palette.text,
          fontVariantNumeric: "tabular-nums",
          letterSpacing:      "-0.3px",
        }}
      >
        {costLabel}
      </div>

      {/* Tokens */}
      <div style={{ fontSize: 11, color: palette.textDim, fontFamily: "var(--font-mono), monospace" }}>
        {abbrev(item.tokens)} tok
      </div>

      {/* Top model / repo */}
      {item.topModel && (
        <div
          style={{
            fontSize:     10,
            color:        palette.textMute,
            overflow:     "hidden",
            textOverflow: "ellipsis",
            whiteSpace:   "nowrap",
          }}
        >
          {item.topModel}
        </div>
      )}
      {item.topRepo && (
        <div
          style={{
            fontSize:     10,
            color:        palette.textMute,
            overflow:     "hidden",
            textOverflow: "ellipsis",
            whiteSpace:   "nowrap",
          }}
        >
          {item.topRepo.split("/").pop()}
        </div>
      )}

      {/* 7d sparkline */}
      {item.sparkline.length > 0 && (
        <div style={{ marginTop: 2 }}>
          <MiniBars values={item.sparkline} color={color} />
        </div>
      )}

      {/* Subscription badge */}
      {item.subscription && (
        <div
          style={{
            fontSize:     9,
            color:        palette.cyan,
            background:   `${palette.cyan}18`,
            borderRadius: radius.sm,
            padding:      "2px 5px",
            alignSelf:    "flex-start",
            fontFamily:   "var(--font-mono), monospace",
            textTransform:"uppercase",
            letterSpacing:"0.5px",
          }}
        >
          subscription
        </div>
      )}
    </div>
  );
}

export function StackPanel({ items }: Props): ReactElement {
  return (
    <div
      style={{
        display:   "flex",
        flexWrap:  "wrap",
        gap:       12,
        width:     "100%",
      }}
    >
      {items.map((item) => (
        <SourceCard key={item.source} item={item} />
      ))}
    </div>
  );
}
