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

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
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
  const prefs = await loadPrefs(me.id);

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
