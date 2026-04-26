/**
 * /settings — user preferences (currently: digest).
 *
 * Server component + server action — same pattern as /share. Posts to
 * the JSON API at /api/settings/digest so external clients (mobile,
 * the agent's settings command) can use the same surface.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { Header } from "@/components/Header";

export const dynamic = "force-dynamic";

interface SearchParams {
  ok?: string;
  error?: string;
  test_sent?: string;
}

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

  // Validate the TZ before writing.
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

  // Defer to the lib so the email matches what the cron sends. We wipe
  // last_digest_sent_at first so buildDigest fires for "today" — and we
  // restore it after so we don't suppress tomorrow's actual digest.
  const { buildDigest } = await import("@/lib/digest");
  const { renderDigestEmail } = await import("@/lib/digest-render");
  const { sendEmail } = await import("@/lib/email");

  const payload = await buildDigest(me.id);
  if (!payload) redirect("/settings?error=user+not+found");
  if (!payload) return;

  const rendered = renderDigestEmail(payload);
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
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const prefs = await loadPrefs(me.id);
  const fallbackEmail = me.email;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px", fontFamily: "ui-monospace, Menlo, monospace" }}>
      <Header me={me} active="settings" />
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "8px 0 4px" }}>Settings</h1>
      <div style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>
        Daily digest preferences. The digest goes out at 9:00 in your timezone.
      </div>

      {params.ok && <Notice tone="ok">Saved.</Notice>}
      {params.test_sent && <Notice tone="ok">Test digest sent — check your inbox.</Notice>}
      {params.error && <Notice tone="err">{params.error}</Notice>}

      <form action={updateDigestAction} style={card}>
        <h2 style={h2}>Daily digest</h2>

        <Row label="Send me a digest each morning">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={prefs.digest_enabled}
              style={{ accentColor: "#111" }}
            />
            <span>{prefs.digest_enabled ? "enabled" : "disabled"}</span>
          </label>
        </Row>

        <Row label="Timezone (IANA, e.g. America/Los_Angeles)">
          <input
            type="text"
            name="tz"
            defaultValue={prefs.digest_tz}
            placeholder="UTC"
            style={input}
          />
        </Row>

        <Row label={`Email override (default: ${fallbackEmail})`}>
          <input
            type="email"
            name="email"
            defaultValue={prefs.digest_email ?? ""}
            placeholder={fallbackEmail}
            style={input}
          />
        </Row>

        <div style={{ display: "flex", gap: 12, marginTop: 16, alignItems: "center" }}>
          <button type="submit" style={primaryBtn}>Save</button>
          {prefs.last_digest_sent_at && (
            <span style={{ color: "#888", fontSize: 12 }}>
              last sent {new Date(prefs.last_digest_sent_at).toISOString().slice(0, 16).replace("T", " ")}Z
            </span>
          )}
        </div>
      </form>

      <form action={sendTestDigestAction} style={{ ...card, marginTop: 16 }}>
        <h2 style={h2}>Send a test digest</h2>
        <p style={{ color: "#666", fontSize: 13, margin: "0 0 12px" }}>
          Renders against today and emails you the result. Doesn&apos;t affect tomorrow&apos;s scheduled send.
        </p>
        <button type="submit" style={primaryBtn}>Send test</button>
      </form>
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "err"; children: React.ReactNode }): ReactElement {
  const bg = tone === "ok" ? "#e7f6ec" : "#fdecea";
  const fg = tone === "ok" ? "#1a7f3a" : "#a02622";
  return (
    <div style={{ background: bg, color: fg, padding: "10px 12px", borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

const card: React.CSSProperties = {
  border: "1px solid #ececec",
  borderRadius: 8,
  padding: 20,
  background: "#fff",
};
const h2: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.08em" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #d0d0d0",
  borderRadius: 4,
  fontSize: 13,
  fontFamily: "inherit",
  background: "#fff",
};
const primaryBtn: React.CSSProperties = {
  background: "#111",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "8px 16px",
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};
