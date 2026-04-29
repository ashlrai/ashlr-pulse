/**
 * StatCard.tsx — headline-number card with optional sparkline + delta.
 *
 * The dashboard's top strip uses these to give the user a 1-second read
 * on "am I shipping more or less than yesterday?" before they ever look
 * at a table. Sparkline is an SVG path; no chart library required.
 */

import type { ReactElement, ReactNode } from "react";
import { palette, radius, space, shadow } from "@/lib/theme";

export interface StatCardProps {
  label: string;
  value: string | number;
  /** Optional secondary line: comparison to previous period. */
  hint?: string;
  /** Delta vs prior period (-1.0 to +∞). Renders a colored chip. */
  delta?: number | null;
  /** Up-to-N points sparkline (SVG path). When omitted, no sparkline renders. */
  sparkline?: number[];
  /** Token-color cue: green = positive, magenta = secondary, etc. */
  accent?: "green" | "magenta" | "cyan" | "amber" | "purple";
  /** Optional icon/glyph to the left of the label. */
  glyph?: ReactNode;
}

const ACCENT: Record<NonNullable<StatCardProps["accent"]>, string> = {
  green:   palette.green,
  magenta: palette.magenta,
  cyan:    palette.cyan,
  amber:   palette.amber,
  purple:  palette.purple,
};

export function StatCard({
  label, value, hint, delta, sparkline, accent = "green", glyph,
}: StatCardProps): ReactElement {
  const accentColor = ACCENT[accent];

  return (
    <div
      style={{
        flex:         "1 1 180px",
        minWidth:     180,
        padding:      `${space.x3}px ${space.x4}px ${space.x4}px`,
        background:   palette.bgSurface,
        border:       `1px solid ${palette.border}`,
        borderTop:    `1.5px solid ${accentColor}`,
        borderRadius: radius.lg,
        boxShadow:    shadow.card,
        position:     "relative",
        overflow:     "hidden",
      }}
    >
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          gap:            6,
          fontSize:       11,
          color:          palette.textDim,
          textTransform:  "uppercase",
          letterSpacing:  "0.8px",
          fontWeight:     500,
        }}
      >
        {glyph && <span style={{ color: accentColor, lineHeight: 1 }}>{glyph}</span>}
        {label}
      </div>

      <div
        style={{
          marginTop:          6,
          fontSize:           28,
          fontWeight:         600,
          color:              palette.text,
          fontVariantNumeric: "tabular-nums",
          letterSpacing:      "-0.5px",
          lineHeight:         1,
        }}
      >
        {value}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, minHeight: 14 }}>
        {delta != null && (
          <DeltaChip delta={delta} accent={accentColor} />
        )}
        {hint && (
          <span style={{ fontSize: 11, color: palette.textMute, fontVariantNumeric: "tabular-nums" }}>
            {hint}
          </span>
        )}
      </div>

      {sparkline && sparkline.length >= 2 && (
        <Sparkline values={sparkline} stroke={accentColor} />
      )}
    </div>
  );
}

function DeltaChip({ delta, accent }: { delta: number; accent: string }): ReactElement {
  const up = delta >= 0;
  const arrow = up ? "↑" : "↓";
  const pct = Math.abs(delta) * 100;
  const text = pct >= 100 ? `${(delta + 1).toFixed(1)}×` : `${pct.toFixed(0)}%`;
  const color = up ? accent : palette.textDim;
  return (
    <span
      style={{
        fontSize:           10.5,
        color,
        fontVariantNumeric: "tabular-nums",
        fontWeight:         500,
        letterSpacing:      "0.3px",
      }}
    >
      {arrow} {text}
    </span>
  );
}

/**
 * Inline SVG sparkline — no chart lib, no client JS. Auto-scales,
 * soft gradient fill below the line.
 */
function Sparkline({ values, stroke }: { values: number[]; stroke: string }): ReactElement {
  const w = 220, h = 36;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const step = w / (values.length - 1);
  const pts = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 4) - 2}`)
    .join(" ");
  const fillPath =
    `M0,${h} L${pts.replace(/ /g, " L")} L${w},${h} Z`;

  // Each card gets a unique gradient ID — collisions across instances on
  // the same page would bleed colors otherwise.
  const gradId = `spark-${stroke.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="none"
      style={{ marginTop: space.x2, opacity: 0.85 }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={stroke} stopOpacity="0.30" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.00" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} stroke="none" />
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
