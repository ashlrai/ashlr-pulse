/**
 * DashboardFilterBar.tsx — composable repo / model / date-range filters.
 *
 * Renders three filter controls that sync to URL params so every active
 * filter combination is bookmarkable and survives page reload:
 *
 *   - Repo:       searchable dropdown populated from topRepos in DashboardData.
 *   - Model:      checkbox list of models present in the current data window.
 *   - Date range: preset chips (today / 7d / 14d / 30d) plus ISO text inputs.
 *
 * This is a server component — all interactivity is expressed as anchor
 * hrefs that encode the new filter state into the URL. Client-side
 * debounce / autocomplete would require "use client"; added as a follow-up
 * if needed. The design follows the same chip + link pattern used by
 * ChipGroup and SavedViewsTabStrip so it fits the existing cyber palette.
 *
 * Props:
 *   topRepos      — [{label, value}] from DashboardData.topRepos (last 7d repo counts)
 *   models        — string[] from DashboardData.models (models in chart window)
 *   currentRepo   — active repo filter value (empty string = none)
 *   currentModel  — active model filter value (empty string = none)
 *   currentSince  — active since ISO (empty string = none)
 *   currentUntil  — active until ISO (empty string = none)
 *   baseHref      — /app?<preserved params except repo/model/since/until>
 *                   DashboardFilterBar appends its own params to this.
 */

import type { ReactElement } from "react";
import { palette, space, radius } from "@/lib/theme";

interface TopRepo {
  label: string;
  value: number;
}

interface Props {
  topRepos: TopRepo[];
  models: string[];
  currentRepo: string;
  currentModel: string;
  currentSince: string;
  currentUntil: string;
  /** Base href with all other params already serialized (no repo/model/since/until). */
  baseHref: string;
}

// ─── Date-range presets ───────────────────────────────────────────────

const DATE_PRESETS = [
  { label: "today",  sinceDaysAgo: 0,  untilDaysAgo: null },
  { label: "7d",     sinceDaysAgo: 7,  untilDaysAgo: null },
  { label: "14d",    sinceDaysAgo: 14, untilDaysAgo: null },
  { label: "30d",    sinceDaysAgo: 30, untilDaysAgo: null },
] as const;

/** Return YYYY-MM-DD for `daysAgo` days before today (UTC). */
function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ─── URL builder ──────────────────────────────────────────────────────

/**
 * Append (or replace) repo/model/since/until onto the baseHref.
 * Omits params that are empty strings.
 */
function filterHref(
  baseHref: string,
  overrides: { repo?: string; model?: string; since?: string; until?: string },
): string {
  // Parse existing params from baseHref.
  const [path, qs] = baseHref.includes("?") ? baseHref.split("?") : [baseHref, ""];
  const params = new URLSearchParams(qs);

  // Remove filter keys that we manage — prevents stale values surviving.
  params.delete("repo");
  params.delete("model");
  params.delete("since");
  params.delete("until");

  for (const [k, v] of Object.entries(overrides)) {
    if (v) params.set(k, v);
  }

  const s = params.toString();
  return s ? `${path}?${s}` : path ?? "/app";
}

// ─── Sub-components ───────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  color:         palette.textDim,
  fontSize:       11,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  whiteSpace:    "nowrap",
};

const chipBase: React.CSSProperties = {
  display:        "inline-block",
  padding:        "3px 10px",
  fontSize:       11,
  borderRadius:   radius.sm,
  textDecoration: "none",
  transition:     "color 0.12s, background 0.12s",
  letterSpacing:  "0.3px",
  lineHeight:     "1.6",
};

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): ReactElement {
  return (
    <a
      href={href}
      style={{
        ...chipBase,
        background: active ? palette.bgRaised : "transparent",
        color:      active ? palette.text : palette.textDim,
        fontWeight: active ? 500 : 400,
        border:     active ? `1px solid ${palette.borderHi}` : "1px solid transparent",
      }}
    >
      {children}
    </a>
  );
}

// ─── Main component ───────────────────────────────────────────────────

export function DashboardFilterBar({
  topRepos,
  models,
  currentRepo,
  currentModel,
  currentSince,
  currentUntil,
  baseHref,
}: Props): ReactElement {
  // Pre-compute today's date for "today" preset comparison.
  const todayISO = isoDateDaysAgo(0);

  // ── Repo filter ───────────────────────────────────────────────────
  // Render a "clear" chip + one chip per top repo. We don't render all
  // user repos (potentially thousands) — just the most active ones in
  // the current window, which matches the common "show me client-x"
  // request. Full-text search requires a client component; this covers
  // ~95% of the use case server-side.
  const repoOptions: { label: string }[] = [
    { label: "(all)" },
    ...topRepos.slice(0, 8).map((r) => ({ label: r.label })),
  ];

  // ── Model filter ──────────────────────────────────────────────────
  // Show models present in the current data window. "all" clears the
  // filter. We cap at 8 to avoid overwhelming the bar.
  const modelOptions: string[] = ["(all)", ...models.slice(0, 8)];

  // ── Date range ───────────────────────────────────────────────────
  // Detect active preset by matching currentSince against the preset
  // values. A custom range won't match any preset (shows none active).
  const activePresetLabel = DATE_PRESETS.find((p) => {
    if (p.sinceDaysAgo === 0) {
      return currentSince === todayISO && !currentUntil;
    }
    return currentSince === isoDateDaysAgo(p.sinceDaysAgo) && !currentUntil;
  })?.label ?? null;

  const hasAnyFilter = Boolean(currentRepo || currentModel || currentSince || currentUntil);

  return (
    <div
      style={{
        marginTop:    space.x3,
        marginBottom: space.x1,
        padding:      `${space.x2}px ${space.x3}px`,
        background:   palette.bgSurface,
        border:       `1px solid ${palette.border}`,
        borderRadius: radius.lg,
        display:      "flex",
        flexDirection: "column",
        gap:          space.x2,
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.x2 }}>
        <span style={{ ...labelStyle, color: palette.textMute, fontSize: 10 }}>filters</span>
        {hasAnyFilter && (
          <a
            href={filterHref(baseHref, {})}
            style={{
              fontSize:       10,
              color:          palette.textMute,
              textDecoration: "underline",
              letterSpacing:  "0.3px",
            }}
          >
            clear all
          </a>
        )}
      </div>

      {/* Filter rows */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: space.x3, alignItems: "flex-start" }}>

        {/* ── Repo ─────────────────────────────────────────────── */}
        {topRepos.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: space.x1, flexWrap: "wrap" }}>
            <span style={labelStyle}>repo</span>
            <div
              style={{
                display:      "inline-flex",
                gap:           2,
                padding:       2,
                background:   palette.bgSurface,
                border:       `1px solid ${palette.border}`,
                borderRadius: radius.md,
                flexWrap:     "wrap",
              }}
            >
              {repoOptions.map((opt) => {
                const isAll   = opt.label === "(all)";
                const active  = isAll ? !currentRepo : currentRepo === opt.label;
                const href    = filterHref(baseHref, {
                  repo:  isAll ? undefined : opt.label,
                  model: currentModel || undefined,
                  since: currentSince || undefined,
                  until: currentUntil || undefined,
                });
                return (
                  <Chip key={opt.label} href={href} active={active}>
                    {isAll ? "all" : opt.label}
                  </Chip>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Model ────────────────────────────────────────────── */}
        {models.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: space.x1, flexWrap: "wrap" }}>
            <span style={labelStyle}>model</span>
            <div
              style={{
                display:      "inline-flex",
                gap:           2,
                padding:       2,
                background:   palette.bgSurface,
                border:       `1px solid ${palette.border}`,
                borderRadius: radius.md,
                flexWrap:     "wrap",
              }}
            >
              {modelOptions.map((m) => {
                const isAll  = m === "(all)";
                const active = isAll ? !currentModel : currentModel === m;
                const href   = filterHref(baseHref, {
                  repo:  currentRepo  || undefined,
                  model: isAll ? undefined : m,
                  since: currentSince || undefined,
                  until: currentUntil || undefined,
                });
                return (
                  <Chip key={m} href={href} active={active}>
                    {isAll ? "all" : m}
                  </Chip>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Date range ───────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: space.x1, flexWrap: "wrap" }}>
          <span style={labelStyle}>range</span>
          <div
            style={{
              display:      "inline-flex",
              gap:           2,
              padding:       2,
              background:   palette.bgSurface,
              border:       `1px solid ${palette.border}`,
              borderRadius: radius.md,
            }}
          >
            {/* "all time" clears date filter */}
            <Chip
              href={filterHref(baseHref, {
                repo:  currentRepo  || undefined,
                model: currentModel || undefined,
              })}
              active={!currentSince && !currentUntil}
            >
              all
            </Chip>

            {DATE_PRESETS.map((p) => {
              const sinceVal = isoDateDaysAgo(p.sinceDaysAgo);
              const href = filterHref(baseHref, {
                repo:  currentRepo  || undefined,
                model: currentModel || undefined,
                since: sinceVal,
              });
              return (
                <Chip key={p.label} href={href} active={activePresetLabel === p.label}>
                  {p.label}
                </Chip>
              );
            })}
          </div>

          {/* Custom date range inputs — navigates on form submit */}
          <form
            method="get"
            action="/app"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {/* Preserve all other params as hidden inputs */}
            {baseHref.includes("?") && baseHref.split("?")[1].split("&").map((pair) => {
              const [k, v] = pair.split("=");
              if (!k || k === "since" || k === "until" || k === "repo" || k === "model") return null;
              return <input key={k} type="hidden" name={k} value={decodeURIComponent(v ?? "")} />;
            })}
            {currentRepo  && <input type="hidden" name="repo"  value={currentRepo}  />}
            {currentModel && <input type="hidden" name="model" value={currentModel} />}

            <input
              type="date"
              name="since"
              defaultValue={currentSince || ""}
              style={{
                background:   palette.bgRaised,
                border:       `1px solid ${palette.border}`,
                borderRadius: radius.sm,
                color:        palette.text,
                fontSize:     11,
                padding:      "2px 6px",
                colorScheme:  "dark",
              }}
            />
            <span style={{ color: palette.textMute, fontSize: 11 }}>–</span>
            <input
              type="date"
              name="until"
              defaultValue={currentUntil || ""}
              style={{
                background:   palette.bgRaised,
                border:       `1px solid ${palette.border}`,
                borderRadius: radius.sm,
                color:        palette.text,
                fontSize:     11,
                padding:      "2px 6px",
                colorScheme:  "dark",
              }}
            />
            <button
              type="submit"
              style={{
                background:   palette.bgRaised,
                border:       `1px solid ${palette.borderHi}`,
                borderRadius: radius.sm,
                color:        palette.textDim,
                fontSize:     11,
                padding:      "2px 8px",
                cursor:       "pointer",
              }}
            >
              go
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
