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
import { getAccountForUser, listEnabledRepos, setRepoEnabled } from "@/lib/github-account-db";
import { syncAccount } from "@/lib/github-sync";
import { sql } from "@/lib/db";
import { signOutAction } from "@/lib/auth-actions";

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
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const account = await getAccountForUser(me.id);
  const { ok, error } = await searchParams;

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 960,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · github</h1>
      <p style={{ color: "#666", marginTop: 4 }}>
        you: <code>{me.email}</code> · <a href="/">dashboard →</a> ·{" "}
        <a href="/share">sharing →</a> ·{" "}
        <form action={signOutAction} style={{ display: "inline" }}>
          <button type="submit" style={linkBtn}>sign out</button>
        </form>
      </p>

      {ok && <p style={{ color: "#080" }}>connected.</p>}
      {error && <p style={{ color: "#c00" }}>error: {error}</p>}

      {!account ? (
        <NotConnected />
      ) : (
        <Connected account={account} />
      )}
    </main>
  );
}

function NotConnected(): ReactElement {
  return (
    <section style={{ marginTop: 32 }}>
      <p>
        Connect your GitHub account to start ingesting commits, PRs, and
        reviews. We request: <code>read:user</code>, <code>repo</code>,{" "}
        <code>read:org</code>.
      </p>
      <p style={{ color: "#666", fontSize: 13 }}>
        Privacy floor: we ingest event metadata (commit SHAs, PR numbers, state,
        diff <em>counts</em>) — never commit bodies, PR descriptions, review
        comment text, or issue bodies.
      </p>
      <a href="/api/github/oauth/start" style={primaryBtn}>connect github</a>
    </section>
  );
}

async function Connected({
  account,
}: {
  account: NonNullable<Awaited<ReturnType<typeof getAccountForUser>>>;
}): Promise<ReactElement> {
  const repos = await loadAllRepos(account.id);
  const enabled = repos.filter((r) => r.enabled);
  const disabled = repos.filter((r) => !r.enabled);
  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {account.avatar_url && (
          <img src={account.avatar_url} alt="" width={40} height={40} style={{ borderRadius: 20 }} />
        )}
        <div>
          <div>
            <strong>@{account.github_login}</strong> · scopes:{" "}
            <code>{account.scopes.join(", ")}</code>
          </div>
          <div style={{ color: "#666", fontSize: 13 }}>
            {account.last_synced_at
              ? <>last synced: <code>{new Date(account.last_synced_at).toISOString().slice(0, 19).replace("T", " ")}Z</code></>
              : "never synced"}
            {account.sync_error && (
              <span style={{ color: "#c00" }}> · error: {account.sync_error}</span>
            )}
          </div>
        </div>
      </div>

      <form action={syncNowAction} style={{ marginTop: 16 }}>
        <button type="submit" style={primaryBtn}>sync now</button>
      </form>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>tracked repos ({enabled.length})</h2>
      <RepoTable rows={enabled} />

      {disabled.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer" }}>
            disabled repos ({disabled.length})
          </summary>
          <RepoTable rows={disabled} />
        </details>
      )}
    </section>
  );
}

function RepoTable({ rows }: { rows: RepoListRow[] }): ReactElement {
  if (rows.length === 0) {
    return <p style={{ color: "#888" }}>none.</p>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
          <th style={th}>repo</th>
          <th style={th}>branch</th>
          <th style={th}>vis</th>
          <th style={th}>last event</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
            <td style={td}>{r.full_name}{r.is_fork ? " (fork)" : ""}</td>
            <td style={td}>{r.default_branch ?? "—"}</td>
            <td style={td}>{r.is_private ? "private" : "public"}</td>
            <td style={td}>
              {r.last_event_ts
                ? new Date(r.last_event_ts).toISOString().slice(0, 16).replace("T", " ")
                : "—"}
            </td>
            <td style={td}>
              <form action={toggleRepoAction}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="enabled" value={String(r.enabled)} />
                <button type="submit" style={r.enabled ? secondaryBtn : primaryBtn}>
                  {r.enabled ? "disable" : "enable"}
                </button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "#111",
  color: "#fff",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};
const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "transparent",
  color: "#444",
  border: "1px solid #ccc",
};
const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#666",
  fontSize: "inherit",
  padding: 0,
  textDecoration: "underline",
};
const th: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
const td: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
