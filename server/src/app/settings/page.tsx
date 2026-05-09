/**
 * /settings — user preferences (currently: digest).
 *
 * Server component + server action. Posts to the JSON API at
 * /api/settings/digest so external clients (mobile, the agent's
 * settings command) can use the same surface.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import {
  primaryOrgForUser, isOrgAdmin, setBillingMode,
  setSourceSubscriptionMode, setMonthlyBudgetUsd,
  type PerSourceMode, type SourceSubscriptionModes,
} from "@/lib/org-db";
import { type BillingMode, BILLING_MODE_MONTHLY_CAP_USD, isSubscriptionMode } from "@/lib/plan-gate";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Field, Select } from "@/components/ui/Input";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { ok?: string; error?: string; test_sent?: string }

interface Prefs {
  digest_enabled: boolean;
  digest_tz: string;
  digest_email: string | null;
  last_digest_sent_at: string | null;
}

async function loadPrefs(userId: string): Promise<Prefs> {
  const db = sql();
  const [row] = await db<Prefs[]>`
    SELECT digest_enabled, digest_tz, digest_email,
           last_digest_sent_at::text AS last_digest_sent_at
    FROM "user" WHERE id = ${userId}::uuid
  `;
  return row;
}

async function updateDigestAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const enabled = formData.get("enabled") === "on";
  const tz = String(formData.get("tz") ?? "").trim() || "UTC";
  const emailRaw = String(formData.get("email") ?? "").trim();
  const email = emailRaw === "" ? null : emailRaw;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    redirect(`/settings?error=${encodeURIComponent(`unknown timezone: ${tz}`)}`);
  }

  const db = sql();
  await db`
    UPDATE "user" SET
      digest_enabled = ${enabled},
      digest_tz      = ${tz},
      digest_email   = ${email}
    WHERE id = ${me.id}::uuid
  `;
  revalidatePath("/settings");
  redirect("/settings?ok=1");
}

async function updateBillingModeAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const raw = String(formData.get("billing_mode") ?? "");
  const allowed: BillingMode[] = ["api", "pro", "max-100", "max-200", "team", "unknown"];
  if (!allowed.includes(raw as BillingMode)) {
    redirect(`/settings?error=${encodeURIComponent("invalid billing mode")}`);
  }

  const org = await primaryOrgForUser(me.id);
  if (!org) {
    redirect(`/settings?error=${encodeURIComponent("no org")}`);
  }
  if (!(await isOrgAdmin(org.id, me.id))) {
    redirect(`/settings?error=${encodeURIComponent("admin required to change billing mode")}`);
  }

  await setBillingMode(org.id, raw as BillingMode);
  // Plan-gated dashboard pages cache org limits; bust them so the new
  // mode shows up on the next request.
  revalidatePath("/settings");
  revalidatePath("/app");
  revalidatePath("/billing");
  redirect("/settings?ok=1");
}

async function updatePerSourceSubscriptionAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) redirect(`/settings?error=${encodeURIComponent("no org")}`);
  if (!(await isOrgAdmin(org.id, me.id))) {
    redirect(`/settings?error=${encodeURIComponent("admin required")}`);
  }

  // Form encodes one entry per source: `mode_${source}` = "subscription" | "api_priced" | "default".
  // "default" removes the per-source override (falls back to billing_mode).
  const SOURCES = ["claude_code", "codex", "cursor", "copilot", "shell", "git", "wakatime", "ashlr_plugin"];
  const allowedModes: PerSourceMode[] = ["subscription", "api_priced"];

  for (const src of SOURCES) {
    const raw = String(formData.get(`mode_${src}`) ?? "default");
    if (raw === "default") {
      try { await setSourceSubscriptionMode(org.id, src, null); } catch { /* unknown source — ignore */ }
    } else if (allowedModes.includes(raw as PerSourceMode)) {
      try { await setSourceSubscriptionMode(org.id, src, raw as PerSourceMode); } catch { /* ignore */ }
    }
  }

  // Optional monthly budget (used by /forecast). Empty string = clear.
  const budgetRaw = String(formData.get("monthly_budget_usd") ?? "").trim();
  if (budgetRaw === "") {
    await setMonthlyBudgetUsd(org.id, null);
  } else {
    const n = Number(budgetRaw);
    if (Number.isFinite(n) && n >= 0 && n < 1_000_000) {
      await setMonthlyBudgetUsd(org.id, n);
    }
  }

  revalidatePath("/settings");
  revalidatePath("/app");
  revalidatePath("/forecast");
  redirect("/settings?ok=1");
}

async function sendTestDigestAction(): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const { buildDigest } = await import("@/lib/digest");
  const { renderDigestEmail } = await import("@/lib/digest-render");
  const { briefingForDigest } = await import("@/lib/briefing");
  const { sendEmail } = await import("@/lib/email");

  const payload = await buildDigest(me.id);
  if (!payload) redirect("/settings?error=user+not+found");
  if (!payload) return;

  const briefing = await briefingForDigest(payload);
  const rendered = renderDigestEmail(payload, { briefing });
  const r = await sendEmail({
    to: payload.email,
    subject: `[test] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });

  if (r.ok) {
    redirect(`/settings?test_sent=1`);
  } else if ("skipped" in r) {
    redirect(`/settings?error=${encodeURIComponent(`email not configured: ${r.reason}`)}`);
  } else {
    redirect(`/settings?error=${encodeURIComponent(`send failed (${r.status})`)}`);
  }
}

export default async function SettingsPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const [prefs, org] = await Promise.all([
    loadPrefs(me.id),
    primaryOrgForUser(me.id),
  ]);
  const billingMode: BillingMode = (org?.billing_mode ?? "api") as BillingMode;
  const monthlyCap = BILLING_MODE_MONTHLY_CAP_USD[billingMode];
  const sourceModes: SourceSubscriptionModes = org?.source_subscription_modes ?? {};
  const monthlyBudget = org?.monthly_budget_usd ?? null;

  return (
    <DashboardShell maxWidth={760}>
      <Header me={me} active="settings" />
      <h1 style={pageTitle}>Settings</h1>
      <div style={pageSub}>Daily digest preferences. The digest goes out at 9:00 in your timezone.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok && <Banner variant="success">Saved.</Banner>}
        {params.test_sent && <Banner variant="success">Test digest sent — check your inbox.</Banner>}
        {params.error && <Banner variant="danger">{params.error}</Banner>}

        <form action={updateDigestAction}>
          <Card>
            <CardHeader title="daily digest" hint="email summary of your activity" />

            <Field label="Send me a digest each morning">
              <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, color: palette.text }}>
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={prefs.digest_enabled}
                  style={{ accentColor: palette.green, width: 16, height: 16 }}
                />
                <span style={{ color: prefs.digest_enabled ? palette.green : palette.textDim }}>
                  {prefs.digest_enabled ? "enabled" : "disabled"}
                </span>
              </label>
            </Field>

            <Field label="Timezone (IANA, e.g. America/Los_Angeles)">
              <Input type="text" name="tz" defaultValue={prefs.digest_tz} placeholder="UTC" />
            </Field>

            <Field
              label="Email override"
              hint={`default: ${me.email}`}
            >
              <Input type="email" name="email" defaultValue={prefs.digest_email ?? ""} placeholder={me.email} />
            </Field>

            <div style={{ display: "flex", gap: space.x3, alignItems: "center", marginTop: space.x4 }}>
              <Button type="submit" variant="primary">Save preferences</Button>
              {prefs.last_digest_sent_at && (
                <span style={{ color: palette.textMute, fontSize: 11 }}>
                  last sent {new Date(prefs.last_digest_sent_at).toISOString().slice(0, 16).replace("T", " ")}Z
                </span>
              )}
            </div>
          </Card>
        </form>

        <form action={updateBillingModeAction}>
          <Card>
            <CardHeader
              title="cost-display mode"
              hint="how Pulse should label the cost numbers on your dashboard"
            />
            <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, margin: `0 0 ${space.x3}px` }}>
              Pulse computes <em>API rate-card cost</em> for every span — what
              an API user would pay at Anthropic&apos;s published rates ($5/M
              input, $25/M output for Opus 4.7, plus 0.10× / 1.25× / 2× input
              for cache read / 5m write / 1h write). If you pay Anthropic via
              <strong> Claude Code Pro / Max</strong>, your real bill is the
              flat plan price — pick that here so the dashboard labels the
              rate-card number as a hypothetical and shows your plan
              utilization.
            </p>

            <Field label="Billing mode">
              <Select name="billing_mode" defaultValue={billingMode} required>
                <option value="api">API pay-as-you-go (rate-card = real bill)</option>
                <option value="pro">Claude Code Pro ($20/mo)</option>
                <option value="max-100">Claude Code Max ($100/mo)</option>
                <option value="max-200">Claude Code Max ($200/mo)</option>
                <option value="team">Anthropic Team (usage-based per-seat)</option>
                <option value="unknown">Not sure / mixed</option>
              </Select>
            </Field>

            {isSubscriptionMode(billingMode) && monthlyCap && (
              <p style={{ color: palette.textMute, fontSize: 11, margin: `${space.x2}px 0 0` }}>
                Subscription mode: dashboard will show rate-card cost as a
                hypothetical and a "X% of ~${monthlyCap}/mo cap" indicator.
                The cap is approximate (Anthropic doesn&apos;t publish exact
                quotas) — adjust if your experience differs.
              </p>
            )}

            <div style={{ display: "flex", gap: space.x3, alignItems: "center", marginTop: space.x4 }}>
              <Button type="submit" variant="primary">Save mode</Button>
            </div>
          </Card>
        </form>

        <form action={updatePerSourceSubscriptionAction}>
          <Card>
            <CardHeader
              title="per-source subscription"
              hint="exclude subscription-covered sources from headline cost totals"
            />
            <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, margin: `0 0 ${space.x3}px` }}>
              For each source, choose whether usage is billed via API
              pay-as-you-go (rate-card cost = real bill) or covered by a
              subscription (Codex via ChatGPT Pro, Copilot via the
              GitHub plan, etc.). Subscription-flagged sources are
              shown with <strong>$0 effective cost</strong> on stat cards
              and trajectory charts — but the rate-card cost remains
              visible in per-source breakdowns so the
              "what would API cost" narrative stays intact. Codex
              auto-defaults to subscription when the agent reports a
              Plus/Pro plan_type.
            </p>

            {([
              ["claude_code",  "Claude Code"],
              ["codex",        "Codex CLI"],
              ["cursor",       "Cursor"],
              ["copilot",      "GitHub Copilot"],
              ["shell",        "Shell-hook (other CLIs)"],
              ["wakatime",     "WakaTime"],
              ["ashlr_plugin", "ashlr plugin"],
            ] as const).map(([src, label]) => {
              const cur = sourceModes[src] ?? "default";
              return (
                <Field key={src} label={label}>
                  <Select name={`mode_${src}`} defaultValue={cur}>
                    <option value="default">default (use billing_mode above)</option>
                    <option value="subscription">subscription — exclude from cost totals</option>
                    <option value="api_priced">API-priced — include in cost totals</option>
                  </Select>
                </Field>
              );
            })}

            <Field label="Monthly budget (USD, optional — used by /forecast burn-down)">
              <Input
                type="number"
                step="0.01"
                min="0"
                name="monthly_budget_usd"
                defaultValue={monthlyBudget ?? ""}
                placeholder="e.g. 200"
              />
            </Field>

            <div style={{ display: "flex", gap: space.x3, alignItems: "center", marginTop: space.x4 }}>
              <Button type="submit" variant="primary">Save subscription map</Button>
            </div>
          </Card>
        </form>

        <form action={sendTestDigestAction}>
          <Card>
            <CardHeader title="send a test digest" />
            <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, margin: `0 0 ${space.x3}px` }}>
              Renders against today and emails you the result. Doesn&apos;t affect tomorrow&apos;s scheduled send.
            </p>
            <Button type="submit" variant="secondary">Send test</Button>
          </Card>
        </form>
      </div>
    </DashboardShell>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
