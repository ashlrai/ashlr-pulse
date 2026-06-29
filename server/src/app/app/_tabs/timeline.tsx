/**
 * timeline.tsx — Realtime Activity Timeline tab.
 *
 * Shows an hourly-bucketed scrollable timeline:
 *   - Left gutter: hourly ruler with cost / event / model breakdown.
 *   - Center: clickable event cards showing source, model, tokens,
 *     tool-call sequence, cost.
 *   - Optional session grouping when the `groupBySession` toggle is on.
 *   - Search/filter by repo / model / tool / date-range (URL-persistent).
 *   - JSON export of the current filtered dataset.
 *
 * This is a SERVER component — it receives pre-loaded TimelineData from
 * the shell (page.tsx). Interactive drill-down is handled by client-side
 * URL navigation (clicking a card sets ?event=<id> which the shell reads
 * back and passes as a prop to highlight that event).
 *
 * Privacy floor: renders only the whitelisted columns loaded by
 * timeline-data.ts — no prompts, completions, file paths, or code.
 */

import type { ReactElement, ReactNode } from "react";

import { fmtUsd } from "@/lib/pricing";
import { palette, space } from "@/lib/theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { ChipGroup } from "@/components/ui/ChipGroup";

import type { TimelineData, TimelineEvent, SessionGroup, HourlyBucket } from "@/lib/timeline-data";
import { th, td, abbrev } from "../_components/dashboard-format";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TimelineTabProps {
  tl: TimelineData;
  /** Current filter values (from URL — pre-validated by page.tsx). */
  filters: {
    repo: string;
    model: string;
    tool: string;
    since: string;
    until: string;
    session: string;
    groupBySession: boolean;
  };
  /** Base URL for building filter hrefs (preserves other query params). */
  baseHref: string;
  /** ID of the event to highlight (from ?event=<id>). */
  highlightEventId?: string;
}

// ─── Top-level component ──────────────────────────────────────────────────────

export function TimelineTab({
  tl,
  filters,
  baseHref,
  highlightEventId,
}: TimelineTabProps): ReactElement {
  const hasData = tl.totalEvents > 0;

  return (
    <div style={{ marginTop: space.x4 }}>
      {/* ── Filter / control bar ── */}
      <TimelineFilterBar tl={tl} filters={filters} baseHref={baseHref} />

      {!hasData && (
        <div style={{
          padding: space.x6,
          textAlign: "center",
          color: palette.textMute,
          fontSize: 13,
          border: `1px dashed ${palette.border}`,
          borderRadius: 8,
          marginTop: space.x4,
        }}>
          No activity found for the selected filters.
        </div>
      )}

      {hasData && (
        <div style={{ display: "flex", gap: space.x4, marginTop: space.x4, alignItems: "flex-start" }}>
          {/* ── Left gutter: hourly ruler ── */}
          <HourlyRuler hourly={tl.hourly} />

          {/* ── Center: event feed or sessions ── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {filters.groupBySession && tl.sessions.length > 0 ? (
              <SessionView
                sessions={tl.sessions}
                highlightEventId={highlightEventId}
              />
            ) : (
              <EventFeed
                events={tl.events}
                highlightEventId={highlightEventId}
              />
            )}
          </div>
        </div>
      )}

      {/* ── JSON export ── (server-rendered anchor; data is the filtered set) */}
      {hasData && (
        <JsonExportRow tl={tl} />
      )}
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function TimelineFilterBar({
  tl,
  filters,
  baseHref,
}: {
  tl: TimelineData;
  filters: TimelineTabProps["filters"];
  baseHref: string;
}): ReactElement {
  // Build option lists from discovered values in the data.
  const repoOptions = [
    { label: "all repos", value: "" },
    ...tl.repos.map((r) => ({ label: r, value: r })),
  ];
  const modelOptions = [
    { label: "all models", value: "" },
    ...tl.models.map((m) => ({ label: shortModel(m), value: m })),
  ];
  const toolOptions = [
    { label: "all tools", value: "" },
    ...tl.tools.slice(0, 12).map((t) => ({ label: t, value: t })),
  ];

  const groupHref = buildFilterHref(baseHref, {
    ...filters,
    groupBySession: !filters.groupBySession,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x2 }}>
      {/* Summary line */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.x2 }}>
        <div style={{ fontSize: 12, color: palette.textDim }}>
          <span style={{ color: palette.text, fontVariantNumeric: "tabular-nums" }}>
            {tl.totalEvents.toLocaleString()}
          </span>
          {" events · "}
          <span style={{ color: palette.cyan }}>
            {abbrev(tl.totalTokens)} tok
          </span>
          {tl.totalCostCents > 0 && (
            <>
              {" · "}
              <span style={{ color: palette.green }}>
                {fmtUsd(Math.round(tl.totalCostCents))}
              </span>
            </>
          )}
          {" · last "}
          <span style={{ color: palette.text }}>{tl.days}d</span>
        </div>

        {/* Session group toggle */}
        <a
          href={groupHref}
          style={{
            fontSize: 11,
            color: filters.groupBySession ? palette.cyan : palette.textDim,
            textDecoration: "none",
            border: `1px solid ${filters.groupBySession ? palette.cyan : palette.border}`,
            borderRadius: 4,
            padding: "3px 10px",
            letterSpacing: "0.4px",
          }}
        >
          {filters.groupBySession ? "● session groups" : "○ session groups"}
        </a>
      </div>

      {/* Repo filter */}
      {tl.repos.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
          <span style={{ color: palette.textDim, fontSize: 11, letterSpacing: "0.5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>repo</span>
          <ChipGroup
            current={filters.repo}
            options={repoOptions.slice(0, 10)}
            hrefFor={(v) => buildFilterHref(baseHref, { ...filters, repo: v })}
          />
        </div>
      )}

      {/* Model filter */}
      {tl.models.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
          <span style={{ color: palette.textDim, fontSize: 11, letterSpacing: "0.5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>model</span>
          <ChipGroup
            current={filters.model}
            options={modelOptions.slice(0, 10)}
            hrefFor={(v) => buildFilterHref(baseHref, { ...filters, model: v })}
          />
        </div>
      )}

      {/* Tool filter */}
      {tl.tools.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
          <span style={{ color: palette.textDim, fontSize: 11, letterSpacing: "0.5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>tool</span>
          <ChipGroup
            current={filters.tool}
            options={toolOptions.slice(0, 12)}
            hrefFor={(v) => buildFilterHref(baseHref, { ...filters, tool: v })}
          />
        </div>
      )}
    </div>
  );
}

// ─── Hourly ruler (left gutter) ───────────────────────────────────────────────

function HourlyRuler({ hourly }: { hourly: HourlyBucket[] }): ReactElement {
  if (hourly.length === 0) return <></>;

  // Show last 48 buckets so the gutter doesn't become huge.
  const buckets = [...hourly].reverse().slice(0, 48).reverse();
  const maxEvents = Math.max(...buckets.map((b) => b.events), 1);

  return (
    <div style={{
      width: 140,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      gap: 2,
      position: "sticky",
      top: 16,
      maxHeight: "80vh",
      overflowY: "auto",
    }}>
      <div style={{ fontSize: 10, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>
        hourly
      </div>
      {buckets.map((b) => {
        const pct = (b.events / maxEvents) * 100;
        const label = formatHourLabel(b.hour);
        return (
          <div key={b.hour} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {/* Bar */}
            <div style={{
              width: 48,
              height: 16,
              background: palette.bgRaised,
              borderRadius: 2,
              overflow: "hidden",
              flexShrink: 0,
            }}>
              <div style={{
                height: "100%",
                width: `${pct}%`,
                background: pct > 60 ? palette.cyan : pct > 20 ? palette.green : palette.textMute,
                transition: "width 0.3s",
              }} />
            </div>
            {/* Label */}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9, color: palette.textDim, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {label}
              </div>
              {b.costCents > 0 && (
                <div style={{ fontSize: 9, color: palette.textMute, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUsd(Math.round(b.costCents))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Event feed ───────────────────────────────────────────────────────────────

function EventFeed({
  events,
  highlightEventId,
}: {
  events: TimelineEvent[];
  highlightEventId?: string;
}): ReactElement {
  if (events.length === 0) {
    return (
      <div style={{ color: palette.textMute, fontSize: 13, padding: "10px 0" }}>
        No events to display.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x2 }}>
      {events.map((ev) => (
        <EventCard
          key={ev.id}
          ev={ev}
          highlighted={ev.id === highlightEventId}
        />
      ))}
    </div>
  );
}

// ─── Session view ─────────────────────────────────────────────────────────────

function SessionView({
  sessions,
  highlightEventId,
}: {
  sessions: SessionGroup[];
  highlightEventId?: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x3 }}>
      {sessions.map((sg) => (
        <SessionCard
          key={sg.session_id}
          sg={sg}
          highlightEventId={highlightEventId}
        />
      ))}
    </div>
  );
}

function SessionCard({
  sg,
  highlightEventId,
}: {
  sg: SessionGroup;
  highlightEventId?: string;
}): ReactElement {
  const durationMs = new Date(sg.endTs).getTime() - new Date(sg.startTs).getTime();
  const durationLabel = formatDuration(durationMs);

  return (
    <Card accent={palette.purple}>
      <CardHeader
        title={`session · ${sg.session_id.slice(0, 12)}…`}
        hint={`${sg.events} events · ${durationLabel} · ${sg.sources.join(", ")}`}
      />

      {/* Session summary row */}
      <div style={{ display: "flex", gap: space.x4, marginBottom: space.x3, flexWrap: "wrap" }}>
        <MetaBadge label="events" value={sg.events.toString()} color={palette.cyan} />
        <MetaBadge label="tokens" value={abbrev(sg.tokens)} color={palette.green} />
        {sg.costCents > 0 && (
          <MetaBadge label="cost" value={fmtUsd(Math.round(sg.costCents))} color={palette.amber} />
        )}
        {sg.repos.length > 0 && (
          <MetaBadge label="repos" value={sg.repos.slice(0, 2).join(", ")} color={palette.textDim} />
        )}
        {sg.models.length > 0 && (
          <MetaBadge label="models" value={sg.models.map(shortModel).slice(0, 2).join(", ")} color={palette.magenta} />
        )}
      </div>

      {/* Nested event list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sg.eventList.map((ev) => (
          <EventCard
            key={ev.id}
            ev={ev}
            highlighted={ev.id === highlightEventId}
            compact
          />
        ))}
      </div>
    </Card>
  );
}

// ─── Event card ───────────────────────────────────────────────────────────────

function EventCard({
  ev,
  highlighted,
  compact = false,
}: {
  ev: TimelineEvent;
  highlighted?: boolean;
  compact?: boolean;
}): ReactElement {
  const borderColor = highlighted ? palette.cyan : palette.border;
  const bg = highlighted ? `${palette.cyan}08` : palette.bgSurface;

  return (
    <div style={{
      background: bg,
      border: `1px solid ${borderColor}`,
      borderRadius: 6,
      padding: compact ? `${space.x1}px ${space.x3}px` : `${space.x3}px ${space.x4}px`,
      transition: "border-color 0.15s",
    }}>
      {/* Top row: timestamp + source + model */}
      <div style={{ display: "flex", alignItems: "baseline", gap: space.x2, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: palette.textMute, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {formatEventTs(ev.ts)}
        </span>
        <SourceChip source={ev.source} />
        {ev.model && (
          <span style={{ fontSize: 10, color: palette.magenta, letterSpacing: "0.3px" }}>
            {shortModel(ev.model)}
          </span>
        )}
        {ev.repo && (
          <span style={{ fontSize: 10, color: palette.textDim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
            {ev.repo}
          </span>
        )}
        {ev.fleet_event && (
          <span style={{ fontSize: 10, color: palette.amber, letterSpacing: "0.3px" }}>
            fleet:{ev.fleet_event}
            {ev.fleet_outcome ? `/${ev.fleet_outcome}` : ""}
          </span>
        )}
      </div>

      {/* Token + cost row */}
      <div style={{ display: "flex", alignItems: "center", gap: space.x3, flexWrap: "wrap" }}>
        {(ev.tokens_input != null || ev.tokens_output != null) && (
          <TokenPill
            input={ev.tokens_input ?? 0}
            output={ev.tokens_output ?? 0}
            cache={ev.tokens_cache ?? 0}
          />
        )}
        {ev.costCents != null && ev.costCents > 0 && (
          <span style={{ fontSize: 11, color: palette.green, fontVariantNumeric: "tabular-nums" }}>
            {fmtUsd(Math.round(ev.costCents))}
          </span>
        )}
        {ev.duration_ms != null && (
          <span style={{ fontSize: 10, color: palette.textMute }}>
            {formatDuration(ev.duration_ms)}
          </span>
        )}
      </div>

      {/* Tool call sequence */}
      {ev.tool_calls_types && ev.tool_calls_types.length > 0 && (
        <ToolSequence tools={ev.tool_calls_types} />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SourceChip({ source }: { source: string }): ReactElement {
  const sourceColors: Record<string, string> = {
    claude_code:  palette.green,
    codex:        "#7DFFB3",
    cursor:       palette.cyan,
    copilot:      palette.purple,
    wakatime:     palette.amber,
    git:          palette.magenta,
    shell:        palette.amber,
    ashlr_plugin: palette.purple,
    "ashlr-fleet": palette.cyan,
  };
  const color = sourceColors[source] ?? palette.textDim;
  return (
    <span style={{
      fontSize: 10,
      color,
      background: `${color}15`,
      border: `1px solid ${color}30`,
      borderRadius: 3,
      padding: "1px 6px",
      letterSpacing: "0.3px",
    }}>
      {source}
    </span>
  );
}

function TokenPill({
  input,
  output,
  cache,
}: {
  input: number;
  output: number;
  cache: number;
}): ReactElement {
  return (
    <span style={{ fontSize: 11, color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ color: palette.cyan }}>{abbrev(input)}</span>
      {" in / "}
      <span style={{ color: palette.magenta }}>{abbrev(output)}</span>
      {" out"}
      {cache > 0 && (
        <span style={{ color: palette.textMute }}>
          {" + "}{abbrev(cache)}{" cache"}
        </span>
      )}
    </span>
  );
}

function ToolSequence({ tools }: { tools: string[] }): ReactElement {
  const visible = tools.slice(0, 8);
  const extra = tools.length - visible.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
      {visible.map((t, i) => (
        <span key={`${t}-${i}`} style={{
          fontSize: 10,
          color: palette.textMute,
          background: palette.bgRaised,
          border: `1px solid ${palette.border}`,
          borderRadius: 3,
          padding: "1px 5px",
          fontFamily: "var(--font-mono)",
        }}>
          {t}
        </span>
      ))}
      {extra > 0 && (
        <span style={{ fontSize: 10, color: palette.textMute }}>+{extra} more</span>
      )}
    </div>
  );
}

function MetaBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 9, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px" }}>
        {label}
      </span>
      <span style={{ fontSize: 12, color, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

// ─── JSON export ──────────────────────────────────────────────────────────────

/**
 * Server-rendered export control.
 *
 * We encode the events as a data: URL anchor so no client JS is needed.
 * This works for moderate datasets (< ~5MB). For large exports the real
 * solution is a /api/timeline/export route, but that requires auth — the
 * simple data: href is sufficient for typical 7d windows (< 2k events).
 */
function JsonExportRow({ tl }: { tl: TimelineData }): ReactElement {
  // Build a minimal export payload (omit verbose per-event detail to keep
  // the href size reasonable; provide hourly aggregates + totals).
  const exportData = {
    exported_at: new Date().toISOString(),
    days: tl.days,
    totals: {
      events: tl.totalEvents,
      tokens: tl.totalTokens,
      cost_cents: tl.totalCostCents,
    },
    hourly: tl.hourly.map((b) => ({
      hour: b.hour,
      events: b.events,
      tokens: b.tokens,
      cost_cents: b.costCents,
      models: b.models,
    })),
    events: tl.events.map((e) => ({
      id: e.id,
      ts: e.ts,
      source: e.source,
      model: e.model,
      repo: e.repo,
      tokens_in: e.tokens_input,
      tokens_out: e.tokens_output,
      tokens_cache: e.tokens_cache,
      cost_cents: e.costCents,
      duration_ms: e.duration_ms,
      tools: e.tool_calls_types,
      session_id: e.session_id,
      fleet_event: e.fleet_event,
    })),
  };

  const json = JSON.stringify(exportData, null, 2);
  // Truncate href to 1MB to avoid browser limits on data: URLs.
  const truncated = json.length > 1_000_000;
  const safeJson = truncated ? JSON.stringify({ note: "dataset too large for inline export — use API route", totals: exportData.totals, hourly: exportData.hourly }, null, 2) : json;
  const dataHref = `data:application/json;charset=utf-8,${encodeURIComponent(safeJson)}`;
  const filename = `pulse-timeline-${new Date().toISOString().slice(0, 10)}.json`;

  return (
    <div style={{ marginTop: space.x4, display: "flex", justifyContent: "flex-end" }}>
      <a
        href={dataHref}
        download={filename}
        style={{
          fontSize: 11,
          color: palette.textDim,
          textDecoration: "none",
          border: `1px solid ${palette.border}`,
          borderRadius: 4,
          padding: "5px 12px",
          letterSpacing: "0.4px",
          transition: "color 0.15s, border-color 0.15s",
        }}
      >
        ↓ export JSON{truncated ? " (hourly only)" : ""}
      </a>
    </div>
  );
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Format a session-duration in ms. */
function formatDuration(ms: number): string {
  if (ms < 1_000)   return `${ms}ms`;
  if (ms < 60_000)  return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Format an ISO timestamp to "Jun 29 · 14:37 UTC". */
function formatEventTs(isoTs: string): string {
  const d = new Date(isoTs);
  const month = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} · ${hh}:${mm} UTC`;
}

/** Format a bucket hour key to "Jun 29 14:00". */
function formatHourLabel(hourKey: string): string {
  const d = new Date(hourKey);
  const month = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${month} ${hh}:00`;
}

/** Abbreviate a full model ID: claude-opus-4-7 → opus 4.7 */
function shortModel(m: string): string {
  const t = m.replace(/^claude-/, "");
  return t.replace(/-(\d+)-(\d+)$/, " $1.$2");
}

/** Build a filter href by merging current filters with an override. */
function buildFilterHref(
  base: string,
  filters: {
    repo: string;
    model: string;
    tool: string;
    since: string;
    until: string;
    session: string;
    groupBySession: boolean;
  },
): string {
  // Parse the base URL to extract existing params.
  const [path, existingQs] = base.split("?");
  const qs = new URLSearchParams(existingQs ?? "");

  // Tab is always timeline when building from here.
  qs.set("tab", "timeline");

  // Apply filter overrides.
  if (filters.repo)    qs.set("tl_repo",    filters.repo);
  else                 qs.delete("tl_repo");

  if (filters.model)   qs.set("tl_model",   filters.model);
  else                 qs.delete("tl_model");

  if (filters.tool)    qs.set("tl_tool",    filters.tool);
  else                 qs.delete("tl_tool");

  if (filters.since)   qs.set("since",  filters.since);
  else                 qs.delete("since");

  if (filters.until)   qs.set("until",  filters.until);
  else                 qs.delete("until");

  if (filters.session) qs.set("tl_session", filters.session);
  else                 qs.delete("tl_session");

  if (filters.groupBySession) qs.set("tl_group", "1");
  else                        qs.delete("tl_group");

  const s = qs.toString();
  return s ? `${path}?${s}` : path ?? "/app";
}

// Re-export helper for page.tsx to use when building the baseHref.
export { buildFilterHref };

// Unused import guard (these are referenced in JSX above but TS may warn).
void (th as unknown);
void (td as unknown);
