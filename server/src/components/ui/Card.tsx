/**
 * Card.tsx — surface primitive for the cyber dashboard.
 *
 * Three sizes: tight (for stats), regular (for content), prose (wider
 * left/right padding for text blocks). Optional `accent` prop renders
 * a colored top border for category-coded panels.
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { cardStyle, palette, space } from "@/lib/theme";

interface CardProps {
  children: ReactNode;
  /** Adds a colored top border (1.5px) — useful as a chart category cue. */
  accent?: string;
  /** Inner padding tier. */
  pad?: "tight" | "regular" | "prose";
  /** Inline style overrides applied last. */
  style?: CSSProperties;
}

export function Card({ children, accent, pad = "regular", style }: CardProps): ReactElement {
  const padding =
    pad === "tight" ? `${space.x3}px ${space.x4}px`
    : pad === "prose" ? `${space.x5}px ${space.x6}px`
    : `${space.x4}px ${space.x5}px`;

  return (
    <div
      style={cardStyle({
        padding,
        position: "relative",
        animation: "fade-in-up 0.35s cubic-bezier(0.2, 0.7, 0.2, 1) both",
        ...(accent && {
          borderTop: `1.5px solid ${accent}`,
        }),
        ...style,
      })}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  hint?: string;
  right?: ReactNode;
}

export function CardHeader({ title, hint, right }: CardHeaderProps): ReactElement {
  return (
    <div
      style={{
        display:       "flex",
        alignItems:    "baseline",
        justifyContent:"space-between",
        gap:           space.x3,
        marginBottom:  space.x3,
      }}
    >
      <div>
        <div
          style={{
            fontSize:       11,
            color:          palette.textDim,
            textTransform:  "uppercase",
            letterSpacing:  "0.8px",
            fontWeight:     500,
          }}
        >
          {title}
        </div>
        {hint && (
          <div style={{ fontSize: 11, color: palette.textMute, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      {right && <div style={{ fontSize: 11, color: palette.textDim }}>{right}</div>}
    </div>
  );
}
