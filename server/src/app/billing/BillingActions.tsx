"use client";

/**
 * BillingActions — client buttons that POST to /api/billing/{checkout,portal}
 * and redirect to the URL Stripe returns.
 *
 * Lives in /billing because it's the only place these buttons appear. If
 * we add the same buttons to the dashboard / project pages we'll lift it
 * into components/.
 */

import { useState, type ReactElement } from "react";
import { Button } from "@/components/ui/Button";
import type { BillingPlan, BillingInterval } from "@/lib/billing-config";

interface UpgradeButtonProps {
  plan: BillingPlan;
  interval: BillingInterval;
  label: string;
}

export function UpgradeButton({ plan, interval, label }: UpgradeButtonProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, interval }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setErr(data.error ?? `failed (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Button onClick={go} disabled={busy}>{busy ? "redirecting…" : label}</Button>
      {err && <span style={{ color: "#ff6b6b", fontSize: 11 }}>{err}</span>}
    </div>
  );
}

export function PortalButton({ label = "Manage subscription" }: { label?: string }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setErr(data.error ?? `failed (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Button onClick={go} disabled={busy} variant="secondary">{busy ? "opening…" : label}</Button>
      {err && <span style={{ color: "#ff6b6b", fontSize: 11 }}>{err}</span>}
    </div>
  );
}
