import type { ReactElement } from "react";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

interface TodayRow {
  source: string;
  model: string | null;
  events: number;
  tokens_in:  number | null;
  tokens_out: number | null;
}

async function loadToday(userId: string): Promise<TodayRow[]> {
  try {
    const db = sql();
    return await db<TodayRow[]>`
      SELECT
        source,
        model,
        COUNT(*)::int              AS events,
        SUM(tokens_input)::int     AS tokens_in,
        SUM(tokens_output)::int    AS tokens_out
      FROM activity_event
      WHERE user_id = ${userId}
        AND ts >= NOW() - INTERVAL '24 hours'
      GROUP BY source, model
      ORDER BY events DESC
    `;
  } catch {
    // v0.1: render something even if the db isn't reachable yet so the
    // dogfood flow ("spin up compose, hit endpoint, see rows") has a
    // visible "it's working" signal.
    return [];
  }
}

export default async function Page(): Promise<ReactElement> {
  const userId = process.env.PULSE_DEV_USER ?? "dev-local";
  const rows = await loadToday(userId);
  return (
    <main style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 32, maxWidth: 880 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · today</h1>
      <p style={{ color: "#666", marginTop: 4 }}>user_id: <code>{userId}</code></p>

      {rows.length === 0 ? (
        <p style={{ marginTop: 32, color: "#888" }}>
          No activity yet. Point your OTel exporter at{" "}
          <code>http://localhost:3000/api/otlp/v1/traces</code> and run any
          Claude Code command.
        </p>
      ) : (
        <table style={{ marginTop: 32, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: "8px 0" }}>source</th>
              <th>model</th>
              <th style={{ textAlign: "right" }}>events</th>
              <th style={{ textAlign: "right" }}>tokens in</th>
              <th style={{ textAlign: "right" }}>tokens out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "8px 0" }}>{r.source}</td>
                <td>{r.model ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{r.events}</td>
                <td style={{ textAlign: "right" }}>{r.tokens_in ?? 0}</td>
                <td style={{ textAlign: "right" }}>{r.tokens_out ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
