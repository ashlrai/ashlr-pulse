/**
 * CompareView.tsx — two-column shared-axis layout shell for /compare pages.
 *
 * Server-renderable: pure CSS grid, no chart logic inside. The grid
 * collapses to a single column below ~680px by switching the CSS custom
 * property. Children are any ReactNode (typically charts or stat cards).
 *
 * Inline media queries are not supported in React inline styles, so we
 * use a <style> tag scoped to a unique class for the responsive breakpoint.
 */

import type { ReactElement, ReactNode } from "react";
import { palette, radius, shadow } from "@/lib/theme";

interface Props {
  left:      ReactNode;
  right:     ReactNode;
  title?:    string;
  subtitle?: string;
}

export function CompareView({ left, right, title, subtitle }: Props): ReactElement {
  // Unique class avoids collisions if CompareView is nested.
  const cls = "cv-grid";

  return (
    <div>
      {/* Responsive grid breakpoint — only way to do it with inline CSS in RSC */}
      <style>{`
        .${cls} {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          width: 100%;
          align-items: start;
        }
        @media (max-width: 680px) {
          .${cls} { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* Optional header */}
      {(title || subtitle) && (
        <div style={{ marginBottom: 16 }}>
          {title && (
            <div
              style={{
                fontSize:      15,
                fontWeight:    600,
                color:         palette.text,
                letterSpacing: "-0.2px",
              }}
            >
              {title}
            </div>
          )}
          {subtitle && (
            <div
              style={{
                fontSize:  12,
                color:     palette.textDim,
                marginTop: 3,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}

      {/* Two-column grid */}
      <div className={cls}>
        {/* Left panel */}
        <div
          style={{
            background:   palette.bgSurface,
            border:       `1px solid ${palette.border}`,
            borderRadius: radius.lg,
            boxShadow:    shadow.card,
            padding:      "16px",
            minWidth:     0, // allow shrink inside grid
          }}
        >
          {left}
        </div>

        {/* Divider — hidden on mobile (grid handles layout) */}
        <div
          aria-hidden
          style={{
            display:  "none", // purely decorative; grid gap provides spacing
          }}
        />

        {/* Right panel */}
        <div
          style={{
            background:   palette.bgSurface,
            border:       `1px solid ${palette.border}`,
            borderRadius: radius.lg,
            boxShadow:    shadow.card,
            padding:      "16px",
            minWidth:     0,
          }}
        >
          {right}
        </div>
      </div>
    </div>
  );
}
