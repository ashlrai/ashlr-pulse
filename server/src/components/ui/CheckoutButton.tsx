"use client";

/**
 * CheckoutButton — POSTs to /api/stripe/checkout, then redirects to
 * the returned Stripe Checkout URL. Variants for "upgrade to Pro" and
 * "manage billing" portal use.
 */

import { useState } from "react";
import { palette, radius, space } from "@/lib/theme";

interface Props {
  /** "checkout" mints a new subscription; "portal" opens billing management. */
  mode: "checkout" | "portal";
  /** Pricing tier when mode === "checkout". Defaults to "pro". */
  plan?: "pro" | "team";
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  /** Disable when caller knows the org isn't eligible (e.g., already paid). */
  disabled?: boolean;
}

export function CheckoutButton({
  mode, plan = "pro", children, variant = "primary", disabled,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const path = mode === "portal" ? "/api/stripe/portal" : "/api/stripe/checkout";
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: mode === "checkout" ? JSON.stringify({ plan }) : "{}",
      });
      const j = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !j.url) {
        setError(j.error ?? `${r.status} ${r.statusText}`);
        setLoading(false);
        return;
      }
      window.location.href = j.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  const bg = variant === "primary" ? palette.magenta : "transparent";
  const fg = variant === "primary" ? "#0a0a0a"      : palette.green;
  const border = variant === "primary" ? palette.magenta : "rgba(124,255,160,0.4)";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={loading || disabled}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: `9px ${space.x4}px`,
          fontSize: 13,
          fontWeight: 500,
          fontFamily: "inherit",
          background: bg,
          color: fg,
          border: `1px solid ${border}`,
          borderRadius: radius.md,
          cursor: loading || disabled ? "not-allowed" : "pointer",
          opacity: loading || disabled ? 0.5 : 1,
          transition: "opacity 0.12s ease",
        }}
      >
        {loading ? "redirecting…" : children}
      </button>
      {error && (
        <span style={{ fontSize: 11, color: palette.red }}>
          {error}
        </span>
      )}
    </span>
  );
}
