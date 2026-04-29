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
import { listGrantsOwnedBy } from "@/lib/peer-share-db";
import { getLastCronRun } from "@/lib/cron-runs";
import { fmtAgo } from "@/lib/heartbeat";
import { palette, space } from "@/lib/theme";

/**
 * Curated IANA timezones — covers ~95% of users. The Input is a free-text
 * field with a <datalist> autocomplete so anything not on this list still
 * works (validated server-side via Intl.DateTimeFormat).
 */
const COMMON_TZS = [
  "UTC",
  "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Anchorage", "America/Honolulu", "America/Mexico_City", "America/Sao_Paulo",
  "America/Toronto", "America/Vancouver",
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "Europe/Amsterdam", "Europe/Stockholm", "Europe/Athens", "Europe/Moscow",
  "Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Singapore", "Asia/Hong_Kong",
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Perth", "Australia/Sydney", "Australia/Melbourne",
  "Pacific/Auckland",
];

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
  const [prefs, ownedGrants, lastCron] = await Promise.all([
    loadPrefs(me.id),
    listGrantsOwnedBy(me.id),
    getLastCronRun("digest"),
  ]);
  const nextSendLabel = describeNextSend(prefs.digest_tz, prefs.digest_enabled);

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

            <Field label="Send me a digest each morning" hint={nextSendLabel}>
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

            <Field label="Timezone (IANA — autocomplete supported)">
              <Input
                type="text"
                name="tz"
                defaultValue={prefs.digest_tz}
                placeholder="UTC"
                list="tz-list"
              />
              <datalist id="tz-list">
                {COMMON_TZS.map((tz) => <option key={tz} value={tz} />)}
              </datalist>
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

        <Card>
          <CardHeader
            title="peer-share grants"
            hint={ownedGrants.length === 0 ? "you have not granted anyone visibility yet" : `${ownedGrants.length} active`}
            right={<a href="/share" style={{ color: palette.cyan, fontSize: 11, textDecoration: "none" }}>manage on /share →</a>}
          />
          {ownedGrants.length === 0 ? (
            <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>
              No grants. Visit <a href="/share" style={{ color: palette.cyan }}>/share</a> to invite a cofounder.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {ownedGrants.slice(0, 5).map((g) => (
                <li
                  key={g.id}
                  style={{
                    padding: `${space.x2}px 0`,
                    borderBottom: `1px dashed ${palette.border}`,
                    fontSize: 12,
                    color: palette.text,
                    display: "flex",
                    alignItems: "center",
                    gap: space.x3,
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {g.viewer_email}
                    <span style={{ color: palette.textMute }}>
                      {" · "}
                      {g.scope_type === "all" ? "all repos" : `${g.scope_type}: ${g.scope_value}`}
                      {" · "}{g.granularity}
                    </span>
                  </span>
                  <a href="/share" style={{ color: palette.green, fontSize: 11, textDecoration: "none" }}>
                    edit →
                  </a>
                </li>
              ))}
              {ownedGrants.length > 5 && (
                <li style={{ padding: `${space.x2}px 0`, fontSize: 11, color: palette.textMute }}>
                  …and {ownedGrants.length - 5} more · <a href="/share" style={{ color: palette.cyan }}>see all</a>
                </li>
              )}
            </ul>
          )}
        </Card>

        <div style={{ color: palette.textMute, fontSize: 11, marginTop: space.x2 }}>
          {lastCron
            ? `digest cron · last tick ${fmtAgo(lastCron.seconds_ago)} ago${lastCron.status >= 200 && lastCron.status < 300 ? " · ok" : ` · http ${lastCron.status}`}`
            : "digest cron · no ticks recorded yet"}
        </div>
      </div>
    </DashboardShell>
  );
}

/**
 * Render a one-line description of when the next digest will fire — e.g.
 * "next send: tomorrow at 9am Europe/Berlin". The cron sweeps every 15
 * min and only sends when local-hour ≥ 9 AND we haven't sent today yet,
 * so this is "the next 9am in the user's TZ that hasn't passed."
 */
function describeNextSend(tz: string, enabled: boolean): string {
  if (!enabled) return "disabled — turn on to receive the morning digest";
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const hour = get("hour");
    const day = hour < 9 ? "today" : "tomorrow";
    return `next send: ${day} at 9am ${tz}`;
  } catch {
    return `unknown timezone: ${tz}`;
  }
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
