/**
 * /attention — effort vs. intent.
 *
 * Two-column layout. Left: where your effort landed this week (project
 * rollup over last 7 days). Right: this week's intent note + a list of
 * recent past intents so the diff is easy to eyeball.
 *
 * The whole point: surface "I said I was going to focus on the auth
 * refactor, but I spent 60% of the week on legacy-tool tickets." That
 * conversation is harder to have without a record of intent vs. actual.
 *
 * v0.3 ROADMAP item — paired with /portfolio.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentUser } from "@/lib/current-user";
import { loadPortfolioHealth } from "@/lib/portfolio-db";
import {
  getIntentForWeek,
  listRecentIntents,
  upsertIntent,
  weekStartUtc,
} from "@/lib/intent-db";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { palette, radius, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { ok?: string; error?: string }

async function saveIntentAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const body = String(formData.get("body") ?? "").trim();
  if (body.length === 0) {
    redirect("/attention?error=intent+cannot+be+empty");
  }
  try {
    await upsertIntent(me.id, weekStartUtc(), body);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    redirect(`/attention?error=${encodeURIComponent(m)}`);
  }
  revalidatePath("/attention");
  redirect("/attention?ok=1");
}

export default async function AttentionPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const week = weekStartUtc();
  const [projects, currentIntent, history] = await Promise.all([
    loadPortfolioHealth(me.id),
    getIntentForWeek(me.id, week),
    listRecentIntents(me.id, 6),
  ]);

  // Rank projects by 7d events for the "actual effort" column.
  const ranked = [...projects].sort((a, b) => b.events_7d - a.events_7d);
  const totalEvents = ranked.reduce((s, p) => s + p.events_7d, 0);

  return (
    <DashboardShell maxWidth={1100}>
      <Header me={me} active="attention" />
      <h1 style={pageTitle}>attention</h1>
      <div style={pageSub}>
        what you said you&apos;d focus on this week, vs. where the work actually landed.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok && <Banner variant="success">intent saved.</Banner>}
        {params.error && <Banner variant="danger">{params.error.replace(/\+/g, " ")}</Banner>}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: space.x4 }} className="dash-grid">
          {/* Effort column */}
          <Card>
            <CardHeader title={`effort · last 7d`} hint={`${totalEvents.toLocaleString()} total events`} />
            {ranked.length === 0 ? (
              <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>
                no projects defined.{" "}
                <a href="/projects" style={{ color: palette.cyan }}>create one</a> to start the diff.
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {ranked.map((p) => {
                  const share = totalEvents === 0 ? 0 : p.events_7d / totalEvents;
                  return (
                    <li
                      key={p.project_id}
                      style={{
                        padding: `${space.x2}px 0`,
                        borderBottom: `1px dashed ${palette.border}`,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", color: palette.text }}>
                        <span>{p.project_name}</span>
                        <span style={{ color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                          {Math.round(share * 100)}% · {p.events_7d} events · {fmtUsd(p.cost_mtd_cents)} mtd
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          height: 4,
                          background: palette.bgRaised,
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.max(2, share * 100)}%`,
                            height: "100%",
                            background: palette.green,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Intent column */}
          <Card>
            <CardHeader title={`intent · week of ${week}`} hint={currentIntent ? "set" : "not yet set"} />
            <form action={saveIntentAction}>
              <textarea
                name="body"
                defaultValue={currentIntent?.body ?? ""}
                placeholder="this week i intend to focus on…"
                maxLength={280}
                rows={4}
                style={{
                  width: "100%",
                  background: palette.bgRaised,
                  color: palette.text,
                  border: `1px solid ${palette.border}`,
                  borderRadius: radius.md,
                  padding: space.x3,
                  fontFamily: "inherit",
                  fontSize: 13,
                  lineHeight: 1.6,
                  resize: "vertical",
                  marginBottom: space.x3,
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Button type="submit" variant="primary" size="sm">
                  {currentIntent ? "update intent" : "save intent"}
                </Button>
                <span style={{ fontSize: 10, color: palette.textMute }}>280 chars max · upserts on save</span>
              </div>
            </form>
          </Card>
        </div>

        <Card>
          <CardHeader title={`recent intents · ${history.length}`} hint="last 6 weeks" />
          {history.length === 0 ? (
            <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>
              no past intents yet — set this week&apos;s above and the history accumulates here.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {history.map((h) => (
                <li
                  key={h.id}
                  style={{
                    padding: `${space.x2}px 0`,
                    borderBottom: `1px dashed ${palette.border}`,
                    fontSize: 12,
                    color: palette.text,
                  }}
                >
                  <span style={{ color: palette.cyan, marginRight: space.x2, fontVariantNumeric: "tabular-nums" }}>
                    {h.week_start}
                  </span>
                  {h.body}
                </li>
              ))}
            </ul>
          )}
        </Card>
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
