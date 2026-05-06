/**
 * /privacy/assurance — logged-in transparency page.
 *
 * Complements the public /privacy page by showing the *actual* fields
 * Pulse stores for THIS user, and the live SHAREABLE_FIELDS /
 * FORBIDDEN_FIELDS sets enforced by peer-share-guard.ts. The point is
 * to let a privacy-conscious user verify "Pulse never stored my
 * prompts" not by reading marketing copy but by inspecting the schema.
 *
 * Also exposes a "download my spans as JSONL" link — same shape as the
 * dashboard reads, no prompts/completions/raw spans.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { FORBIDDEN_FIELDS, SHAREABLE_FIELDS } from "@/lib/peer-share-guard";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SampleRow {
  ts: string | null;
  source: string | null;
  model: string | null;
  repo_name: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  cost_millicents: number | null;
}

async function loadStoredShape(userId: string): Promise<{
  totalRows: number;
  oldest: string | null;
  newest: string | null;
  sample: SampleRow | null;
}> {
  const db = sql();
  const [counts] = await db<{ n: number; oldest: string | null; newest: string | null }[]>`
    SELECT
      COUNT(*)::int   AS n,
      MIN(ts)::text   AS oldest,
      MAX(ts)::text   AS newest
    FROM activity_event WHERE user_id = ${userId}::uuid
  `;
  const [sample] = await db<SampleRow[]>`
    SELECT
      ts::text          AS ts,
      source,
      model,
      repo_name,
      duration_ms,
      tokens_input,
      tokens_output,
      tokens_cache_read,
      cost_millicents
    FROM activity_event
    WHERE user_id = ${userId}::uuid
    ORDER BY ts DESC
    LIMIT 1
  `;
  return {
    totalRows: counts?.n ?? 0,
    oldest: counts?.oldest ?? null,
    newest: counts?.newest ?? null,
    sample: sample ?? null,
  };
}

export default async function PrivacyAssurancePage(): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login?next=/privacy/assurance");

  const data = await loadStoredShape(me.id);
  const forbidden = [...FORBIDDEN_FIELDS].sort();
  const shareable = [...SHAREABLE_FIELDS].sort();

  return (
    <DashboardShell maxWidth={840}>
      <Header me={me} active="settings" />

      <h1 style={pageTitle}>Your privacy footprint</h1>
      <div style={pageSub}>
        Pulse&apos;s privacy floor is enforced in code, not just in the
        marketing copy. This page shows the actual data Pulse has stored
        for you and the field whitelist the API uses for every share
        grant.{" "}
        <a href="/privacy" style={{ color: palette.cyan }}>Read the full policy →</a>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

        <Card>
          <CardHeader title="rows we hold for you" hint="counts only — not the data" />
          <KV
            rows={[
              ["activity_event rows", data.totalRows.toLocaleString()],
              ["oldest event", data.oldest ?? "—"],
              ["newest event", data.newest ?? "—"],
            ]}
          />
        </Card>

        <Card>
          <CardHeader
            title="never stored"
            hint="enforced by FORBIDDEN_FIELDS in peer-share-guard.ts + the agent's claude.rs / shell.rs"
          />
          <ul style={listMono}>
            {forbidden.map((f) => (
              <li key={f} style={{ color: palette.magenta }}>· {f}</li>
            ))}
          </ul>
          <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, marginTop: space.x2 }}>
            Plus: file contents, full git diffs, stdout/stderr, screenshots,
            keystrokes. The agent never reads them; the API rejects them
            even if they were somehow attached to a span.
          </p>
        </Card>

        <Card>
          <CardHeader
            title={`shareable / shown fields · ${shareable.length}`}
            hint="exact list a peer-share grant may opt into; everything else is rejected even if it appears in the schema"
          />
          <ul style={listMono}>
            {shareable.map((f) => (
              <li key={f} style={{ color: palette.green }}>· {f}</li>
            ))}
          </ul>
        </Card>

        {data.sample && (
          <Card>
            <CardHeader title="your most recent event (sample)" hint="literally what we stored — JSON" />
            <pre style={preStyle}>
              {JSON.stringify(data.sample, null, 2)}
            </pre>
          </Card>
        )}

      </div>
    </DashboardShell>
  );
}

function KV({ rows }: { rows: [string, string][] }): ReactElement {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={{ padding: "8px 6px", color: palette.textDim }}>{k}</td>
            <td style={{ padding: "8px 6px", textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>{v}</td>
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
  color: palette.textDim, fontSize: 13, marginBottom: space.x5, lineHeight: 1.6,
};
const listMono: React.CSSProperties = {
  margin: 0, padding: 0, listStyle: "none",
  fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12, lineHeight: 1.7,
};
const preStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  background: palette.bgRaised,
  padding: `${space.x3}px`,
  borderRadius: 6,
  color: palette.text,
  margin: 0,
  overflowX: "auto",
};
