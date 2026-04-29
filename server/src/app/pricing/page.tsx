/**
 * /pricing — public pricing page.
 *
 * Free + Pro tiers. Free is the gateway to adoption; Pro unlocks AI,
 * peer-share, and longer retention. Marketed CTAs:
 *   - signed-out → /login
 *   - signed-in on free → CheckoutButton (Stripe Checkout)
 *   - signed-in on pro/team → "you're already on Pro · manage billing"
 */

import type { ReactElement } from "react";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { isStripeConfigured } from "@/lib/stripe";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { CheckoutButton } from "@/components/ui/CheckoutButton";
import { palette, radius, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { canceled?: string }

const FREE_FEATURES = [
  "1 project, 1 user, 7-day retention",
  "Daily digest email",
  "OTel ingest from Claude Code, Codex, etc.",
  "GitHub OAuth + commit/PR sync",
];

const PRO_FEATURES = [
  "Unlimited projects + members (per-seat billing)",
  "90-day retention",
  "Peer-share with field-level granularity",
  "AI briefing, anomaly explanations, weekly recap",
  "Per-project health cards + attention map",
  "Predictive trends + cohort comparison",
  "Priority email support",
];

export default async function PricingPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  const params = await searchParams;
  const org = me ? await primaryOrgForUser(me.id) : null;
  const stripeReady = isStripeConfigured();
  const onPaidPlan = org && (org.plan === "pro" || org.plan === "team")
    && (org.subscription_status === "active" || org.subscription_status === "trialing");

  return (
    <DashboardShell maxWidth={1000}>
      {me ? <Header me={me} active="settings" /> : <SimpleHeader />}

      <h1 style={pageTitle}>simple pricing</h1>
      <p style={pageSub}>
        free for solo builders. $10 per developer per month for cofounder pairs and teams.
      </p>

      {params.canceled && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="info">checkout canceled — you&apos;re still on the free tier.</Banner>
        </div>
      )}
      {!stripeReady && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="warning" title="billing not configured in this environment">
            STRIPE_SECRET_KEY + STRIPE_PRICE_ID_PRO must be set on the server before checkout works.
          </Banner>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.x4 }} className="dash-grid">
        {/* Free */}
        <Card>
          <CardHeader title="free" hint="for solo builders" />
          <div style={priceBig}>$0</div>
          <div style={priceLabel}>per developer · forever</div>
          <ul style={featureList}>
            {FREE_FEATURES.map((f) => <FeatureRow key={f}>{f}</FeatureRow>)}
          </ul>
          <div style={{ marginTop: space.x4 }}>
            {!me ? (
              <a href="/login" style={ctaSecondary}>sign in to start →</a>
            ) : (
              <span style={{ ...ctaSecondary, color: palette.textMute, cursor: "default" }}>
                {org?.plan === "free" ? "you’re on this plan" : "downgrade via portal"}
              </span>
            )}
          </div>
        </Card>

        {/* Pro */}
        <Card>
          <CardHeader
            title="pro"
            hint="cofounder pair + small teams"
            right={<span style={trialPill}>7-day trial</span>}
          />
          <div style={priceBig}>
            <span>$10</span>
            <span style={priceSub}> / dev / mo</span>
          </div>
          <div style={priceLabel}>billed monthly · cancel anytime</div>
          <ul style={featureList}>
            {PRO_FEATURES.map((f) => <FeatureRow key={f}>{f}</FeatureRow>)}
          </ul>
          <div style={{ marginTop: space.x4 }}>
            {!me ? (
              <a href="/login?next=/pricing" style={ctaPrimary}>sign in to upgrade →</a>
            ) : onPaidPlan ? (
              <span style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
                <span style={{ color: palette.green, fontSize: 13 }}>
                  ✓ you’re on Pro
                  {org?.subscription_status === "trialing" && org?.trial_ends_at && (
                    <span style={{ color: palette.amber, marginLeft: 8 }}>
                      (trial ends {new Date(org.trial_ends_at).toISOString().slice(0, 10)})
                    </span>
                  )}
                </span>
                <CheckoutButton mode="portal" variant="secondary">manage billing →</CheckoutButton>
              </span>
            ) : (
              <CheckoutButton mode="checkout" plan="pro" disabled={!stripeReady}>
                start 7-day trial →
              </CheckoutButton>
            )}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: space.x6, color: palette.textMute, fontSize: 11, lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          all plans are subject to the same hard privacy floor: pulse never stores prompts,
          completions, code, screenshots, or keystrokes.
        </p>
        <p style={{ margin: `${space.x1}px 0 0` }}>
          questions? email <a href="mailto:mason@evero-consulting.com" style={{ color: palette.cyan }}>mason@evero-consulting.com</a>.
        </p>
      </div>
    </DashboardShell>
  );
}

function SimpleHeader(): ReactElement {
  return (
    <header style={{ paddingBottom: space.x4, marginBottom: space.x4, borderBottom: `1px solid ${palette.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <a href="/" style={{ textDecoration: "none", color: palette.text, fontWeight: 600, fontSize: 16 }}>
        Pulse
      </a>
      <a href="/login" style={{ color: palette.cyan, textDecoration: "none", fontSize: 12 }}>sign in →</a>
    </header>
  );
}

function FeatureRow({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <li
      style={{
        display: "flex",
        gap: space.x2,
        alignItems: "baseline",
        padding: `${space.x1}px 0`,
        color: palette.text,
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <span style={{ color: palette.green, fontWeight: 600 }}>✓</span>
      <span>{children}</span>
    </li>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 28, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 14, marginBottom: space.x5,
};
const priceBig: React.CSSProperties = {
  fontSize: 36, fontWeight: 600, color: palette.text,
  fontVariantNumeric: "tabular-nums", marginTop: space.x3,
};
const priceSub: React.CSSProperties = {
  fontSize: 14, color: palette.textDim, fontWeight: 400,
};
const priceLabel: React.CSSProperties = {
  fontSize: 11, color: palette.textDim, marginBottom: space.x4,
};
const featureList: React.CSSProperties = {
  margin: 0, padding: 0, listStyle: "none",
  borderTop: `1px solid ${palette.border}`,
  paddingTop: space.x3,
};
const ctaPrimary: React.CSSProperties = {
  display: "inline-flex",
  padding: `9px ${space.x4}px`,
  background: palette.magenta,
  color: "#0a0a0a",
  borderRadius: radius.md,
  fontWeight: 500,
  fontSize: 13,
  textDecoration: "none",
};
const ctaSecondary: React.CSSProperties = {
  display: "inline-flex",
  padding: `9px ${space.x4}px`,
  border: `1px solid rgba(124,255,160,0.4)`,
  color: palette.green,
  borderRadius: radius.md,
  fontWeight: 500,
  fontSize: 13,
  textDecoration: "none",
};
const trialPill: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
  color: palette.amber,
  border: `1px solid rgba(255,224,122,0.3)`,
  background: "rgba(255,224,122,0.05)",
  padding: "2px 8px",
  borderRadius: 999,
};
