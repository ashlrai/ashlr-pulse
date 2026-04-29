/**
 * Input.tsx — text input + textarea + select primitives matched to the
 * cyber palette. Server-friendly (no React state).
 */

import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactElement } from "react";
import { palette, radius, space } from "@/lib/theme";

const baseStyle: React.CSSProperties = {
  display:      "block",
  width:        "100%",
  padding:      `${space.x2}px ${space.x3}px`,
  fontSize:     13,
  fontFamily:   "inherit",
  color:        palette.text,
  background:   palette.bgRaised,
  border:       `1px solid ${palette.border}`,
  borderRadius: radius.md,
  outline:      "none",
  transition:   "border-color 0.12s ease, box-shadow 0.12s ease",
};

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input {...props} style={{ ...baseStyle, ...props.style }} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return (
    <textarea
      {...props}
      style={{ ...baseStyle, fontFamily: "var(--font-mono), monospace", lineHeight: 1.5, ...props.style }}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <select
      {...props}
      style={{
        ...baseStyle,
        appearance: "none",
        backgroundImage:
          'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\'><path d=\'M2 4l4 4 4-4\' stroke=\'%23888\' fill=\'none\' stroke-width=\'1.4\'/></svg>")',
        backgroundRepeat:   "no-repeat",
        backgroundPosition: "right 10px center",
        backgroundSize:     "10px",
        paddingRight:       28,
        ...props.style,
      }}
    />
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, children }: FieldProps): ReactElement {
  return (
    <label style={{ display: "block", marginBottom: space.x4 }}>
      <span
        style={{
          display:       "block",
          fontSize:      11,
          color:         palette.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.8px",
          marginBottom:  6,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ display: "block", fontSize: 11, color: palette.textMute, marginTop: 6 }}>
          {hint}
        </span>
      )}
    </label>
  );
}
