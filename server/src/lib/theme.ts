/**
 * theme.ts — design tokens for the cyber/agentic UI.
 *
 * The landing + login + privacy + email digest already speak this
 * language. This module codifies the palette so every authenticated
 * surface can render against the same tokens — no more per-page
 * `const card = { padding, ... }` duplication.
 *
 * Conventions:
 *   - Hex strings, not Tailwind classes (we have no Tailwind).
 *   - Functional names (bg, text, border, accent) over color names.
 *   - Numeric scales use rem-equivalent pixel values for spacing.
 */

export const palette = {
  /** Jet-black canvas — same shade used by landing/login. */
  bg:        "#050505",
  /** Slightly lifted surface for cards inside the canvas. */
  bgSurface: "#0b0b0c",
  /** Even lighter for nested cards / hover. */
  bgRaised:  "#121214",
  /** Subtle hairline borders. */
  border:    "#1f1f22",
  /** Brighter border on hover / active. */
  borderHi:  "#2a2a2f",

  /** Body text. */
  text:      "#e8e8e8",
  /** Secondary text — labels, captions. */
  textDim:   "#888",
  /** Tertiary — placeholders. */
  textMute:  "#555",

  /** Accent — primary action, "alive" indicators, success. */
  green:     "#7CFFA0",
  /** Accent — magenta CTA, peer-share, social signals. */
  magenta:   "#FF60D6",
  /** Accent — model / Claude / data. */
  cyan:      "#7CD0FF",
  /** Accent — efficiency / tokens saved / warnings. */
  amber:     "#FFE07A",
  /** Accent — peer / share / collaboration. */
  purple:    "#C99CFF",
  /** Negative / danger. */
  red:       "#FF6B6B",
} as const;

export const space = {
  px: 1, x05: 4, x1: 8, x2: 12, x3: 16, x4: 20, x5: 24, x6: 32, x8: 48, x10: 64,
} as const;

export const radius = {
  sm: 4, md: 6, lg: 10, xl: 14,
} as const;

export const shadow = {
  /** Soft glow on focused/active interactive elements. */
  greenGlow:   "0 0 0 1px rgba(124,255,160,0.5), 0 0 12px rgba(124,255,160,0.18)",
  magentaGlow: "0 0 0 1px rgba(255,96,214,0.5), 0 0 12px rgba(255,96,214,0.18)",
  /** Subtle elevation for raised cards. */
  card:        "0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px rgba(0,0,0,0.35)",
} as const;

export const font = {
  mono:  "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  sans:  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

/**
 * The "chart palette" — ordered list used by stacked-area, bar, donut.
 * First N colors are picked off the front based on series count.
 */
export const chartColors = [
  palette.green,
  palette.magenta,
  palette.cyan,
  palette.amber,
  palette.purple,
  "#9CFFD0",
  "#FFA8E5",
  "#A0E5FF",
  "#FFEAA0",
] as const;

/**
 * Source → color map. Keep stable so users learn "green = claude, magenta = git".
 */
export const sourceColor: Record<string, string> = {
  claude_code:  palette.green,
  cursor:       palette.cyan,
  copilot:      palette.purple,
  wakatime:     palette.amber,
  git:          palette.magenta,
  shell:        palette.amber,
  ashlr_plugin: palette.purple,
  unknown:      palette.textDim,
};

/** Get a chart color by index (wraps). */
export function chartColor(i: number): string {
  return chartColors[i % chartColors.length];
}

/**
 * Style helper: cyber card surface. Use as base, spread overrides.
 */
export const cardStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
  background:    palette.bgSurface,
  border:        `1px solid ${palette.border}`,
  borderRadius:  radius.lg,
  boxShadow:     shadow.card,
  ...extra,
});

/** Subtle glow on hover. */
export const interactiveCardStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
  ...cardStyle(),
  transition: "border-color 0.15s ease, transform 0.15s ease",
  cursor:     "pointer",
  ...extra,
});
