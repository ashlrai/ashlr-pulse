/**
 * DashboardShell.tsx — the dark canvas + monospace + scanline backdrop
 * shared by every authenticated page. Wraps page content so individual
 * pages don't have to re-implement the body background, font, and
 * subtle ambient-grid effect.
 */

import type { ReactElement, ReactNode } from "react";
import { palette, font, space } from "@/lib/theme";

interface Props {
  children: ReactNode;
  /** Optional max-width for the inner container. Default 1240px. */
  maxWidth?: number;
}

export function DashboardShell({ children, maxWidth = 1240 }: Props): ReactElement {
  return (
    <div
      style={{
        minHeight:  "100vh",
        background: palette.bg,
        color:      palette.text,
        fontFamily: font.mono,
        position:   "relative",
        // Faint diagonal hatch + scanlines, identical to landing.
        backgroundImage: `
          radial-gradient(ellipse at top,    rgba(124,255,160,0.03), transparent 60%),
          radial-gradient(ellipse at bottom, rgba(255,96,214,0.03),  transparent 60%),
          repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)
        `,
      }}
    >
      <div
        style={{
          maxWidth,
          margin:  "0 auto",
          padding: `${space.x5}px ${space.x5}px ${space.x10}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
