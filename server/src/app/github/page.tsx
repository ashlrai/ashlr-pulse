/**
 * /github — connect, manage, and sync the GitHub account for this user.
 *
 * Three states:
 *   1. Not connected   → "Connect GitHub" button hits /api/github/oauth/start
 *   2. Connected, never synced → manual "Sync now" + repo list
 *   3. Connected + synced     → last-synced-at, errors, repo enable toggles
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { getAccountForUser, setRepoEnabled } from "@/lib/github-account-db";
import { syncAccount } from "@/lib/github-sync";
import { sql } from "@/lib/db";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { palette, radius, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

async function syncNowAction(): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const account = await getAccountForUser(me.id);
  if (!account) {
    redirect("/api/github/oauth/start");
  }
  if (account) await syncAccount(account);
  revalidatePath("/github");
}

async function toggleRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const account = await getAccountForUser(me.id);
  if (!account) return;
  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  await setRepoEnabled(id, account.id, !enabled);
  revalidatePath("/github");
}

interface RepoListRow {
  id: string;
  full_name: string;
  default_branch: string | null;
  is_private: boolean | null;
  is_fork: boolean | null;
  enabled: boolean;
  last_event_ts: string | null;
}

async function loadAllRepos(accountId: string): Promise<RepoListRow[]> {
  const db = sql();
  return db<RepoListRow[]>`
    SELECT
      r.id::text AS id,
      r.full_name, r.default_branch, r.is_private, r.is_fork, r.enabled,
      (SELECT MAX(ts)::text FROM github_event WHERE repo_id = r.id) AS last_event_ts
    FROM github_repo r
    WHERE r.account_id = ${accountId}
    ORDER BY r.enabled DESC, r.full_name
  `;
}

export default async function GitHubPage({
  searchParams,
}: { searchParams: Promise<{ ok?: string; error?: string }> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const account = await getAccountForUser(me.id);
  const { ok, error } = await searchParams;

  return (
    <DashboardShell maxWidth={1000}>
      <Header me={me} active="github" />
      <h1 style={pageTitle}>github</h1>
      <p style={pageSub}>
        connect your account to ingest commits, PRs, and reviews into the dashboard.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {ok && <Banner variant="success">connected.</Banner>}
        {error && <Banner variant="danger">{error.replace(/\+/g, " ")}</Banner>}
        {!account ? <NotConnected /> : <Connected account={account} />}
      </div>
    </DashboardShell>
  );
}

function NotConnected(): ReactElement {
  return (
    <Card>
      <CardHeader title="not connected" />
      <p style={{ color: palette.text, fontSize: 13, lineHeight: 1.7, marginTop: 0 }}>
        Connect your GitHub account to start ingesting commits, PRs, and reviews.
        We request: <code style={inlineCode}>read:user</code>{" "}
        <code style={inlineCode}>repo</code>{" "}
        <code style={inlineCode}>read:org</code>.
      </p>
      <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.7 }}>
        Privacy floor: we ingest event metadata (commit SHAs, PR numbers, state, diff <em>counts</em>)
        — never commit bodies, PR descriptions, review comment text, or issue bodies.
      </p>
      <a
        href="/api/github/oauth/start"
        style={{
          display: "inline-flex", padding: "9px 16px", marginTop: space.x2,
          background: palette.magenta, color: "#0a0a0a",
          border: "none", borderRadius: radius.md,
          fontWeight: 500, fontSize: 13, textDecoration: "none",
        }}
      >
        connect github
      </a>
    </Card>
  );
}

async function Connected({
  account,
}: { account: NonNullable<Awaited<ReturnType<typeof getAccountForUser>>> }): Promise<ReactElement> {
  const repos = await loadAllRepos(account.id);
  const enabled = repos.filter((r) => r.enabled);
  const disabled = repos.filter((r) => !r.enabled);

  return (
    <>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: space.x3 }}>
          {account.avatar_url && (
            <img
              src={account.avatar_url} alt="" width={44} height={44}
              style={{ borderRadius: 22, border: `1px solid ${palette.border}` }}
            />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ color: palette.text, fontSize: 14 }}>
              <strong style={{ color: palette.green }}>@{account.github_login}</strong>
              <span style={{ color: palette.textDim }}> · scopes: </span>
              <code style={inlineCode}>{account.scopes.join(", ")}</code>
            </div>
            <div style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>
              {account.last_synced_at
                ? <>last synced: <code style={inlineCode}>{new Date(account.last_synced_at).toISOString().slice(0, 19).replace("T", " ")}Z</code></>
                : "never synced"}
            </div>
          </div>
          <form action={syncNowAction}>
            <Button type="submit" variant="primary">sync now</Button>
          </form>
        </div>

        {account.sync_error && (
          <div style={{ marginTop: space.x3 }}>
            <SyncErrorBanner error={account.sync_error} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={`tracked repos · ${enabled.length}`} />
        <RepoTable rows={enabled} />
      </Card>

      {disabled.length > 0 && (
        <Card>
          <details>
            <summary
              style={{
                cursor: "pointer", color: palette.textDim, fontSize: 12,
                textTransform: "uppercase", letterSpacing: "0.8px", fontWeight: 500,
              }}
            >
              disabled repos · {disabled.length}
            </summary>
            <div style={{ marginTop: space.x3 }}>
              <RepoTable rows={disabled} />
            </div>
          </details>
        </Card>
      )}
    </>
  );
}

function isAuthError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("auth") || m.includes("401") || m.includes("bad credentials") ||
    m.includes("token") || m.includes("revoked") || m.includes("expired") ||
    m.includes("missing token")
  );
}

function SyncErrorBanner({ error }: { error: string }): ReactElement {
  const auth = isAuthError(error);
  return (
    <Banner
      variant={auth ? "warning" : "danger"}
      title={auth ? "GitHub access needs to be re-authorized" : "Last sync failed"}
    >
      <div style={{ marginBottom: 8 }}>
        {auth
          ? "Your token may have been revoked or expired — dashboard data is stale until you reconnect."
          : "We'll retry on the next cron tick; if it keeps failing, paste the error to support."}
      </div>
      <code style={{ ...inlineCode, fontSize: 11, opacity: 0.85, display: "block", padding: "6px 8px" }}>
        {error}
      </code>
      {auth && (
        <a
          href="/api/github/oauth/start"
          style={{
            display: "inline-flex", marginTop: 10, padding: "6px 12px",
            background: palette.amber, color: "#0a0a0a",
            borderRadius: radius.sm, fontSize: 12, fontWeight: 500, textDecoration: "none",
          }}
        >
          reconnect github
        </a>
      )}
    </Banner>
  );
}

function RepoTable({ rows }: { rows: RepoListRow[] }): ReactElement {
  if (rows.length === 0) {
    return <p style={{ color: palette.textMute, fontSize: 12 }}>none.</p>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>repo</th>
          <th style={th}>branch</th>
          <th style={th}>vis</th>
          <th style={th}>last event</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={td}>
              <code style={{ color: palette.text }}>
                {r.full_name}
              </code>
              {r.is_fork && <span style={{ color: palette.textMute, marginLeft: 6 }}>(fork)</span>}
            </td>
            <td style={td}>
              <code style={{ color: palette.cyan }}>{r.default_branch ?? "—"}</code>
            </td>
            <td style={td}>
              <span style={{ color: r.is_private ? palette.amber : palette.green }}>
                {r.is_private ? "private" : "public"}
              </span>
            </td>
            <td style={td}>
              {r.last_event_ts
                ? <code style={{ color: palette.textDim }}>{new Date(r.last_event_ts).toISOString().slice(0, 16).replace("T", " ")}</code>
                : <span style={{ color: palette.textMute }}>—</span>}
            </td>
            <td style={{ ...td, textAlign: "right" }}>
              <form action={toggleRepoAction}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="enabled" value={String(r.enabled)} />
                <Button type="submit" variant={r.enabled ? "ghost" : "secondary"} size="sm">
                  {r.enabled ? "disable" : "enable"}
                </Button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const inlineCode: React.CSSProperties = {
  background: palette.bgRaised, color: palette.cyan,
  padding: "1px 6px", borderRadius: 3, fontSize: "0.92em",
};
const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };
