"use client";
/**
 * heatmap.tsx — Realtime peer-share telemetry heatmap tab.
 *
 * Renders a 2D collaboration matrix dashboard:
 *   - Y axis: visible team members (peers who granted access)
 *   - X axis: hourly time buckets over a rolling 7-day window
 *   - Cell intensity: cost_millicents burned in that hour by that peer
 *
 * Features:
 *   - Interactive filter by model, repo, source, and language
 *   - Dimension drill-down via /api/dashboard/peer-share-dimensions
 *     (reads materialised peer_share_daily_agg_by_* tables — no raw event scan)
 *   - Peer relationship status toggle: active grants vs active work
 *   - Hover tooltip with breakdown (cost, events, tokens, top source)
 *   - Export to CSV (privacy-safe: masked emails, numeric only)
 *   - URL-persistent filters via ?hm_model=, ?hm_repo=, ?hm_status=,
 *     ?hm_source=, ?hm_language=
 *
 * Privacy floor: no prompts, no code — numeric aggregates only.
 * Peer emails are masked (e.g. "m***@acme.com") server-side.
 *
 * This is a client component for interactivity (hover state, CSV download).
 * Data is fetched from /api/dashboard/collaboration-matrix on mount and on
 * filter changes. Dimension options are fetched lazily from
 * /api/dashboard/peer-share-dimensions when a shareId is available.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactElement } from "react";
import { palette, space, radius } from "@/lib/theme";
import type { CollaborationMatrix, MatrixCell, PeerMember } from "@/lib/team-collaboration-matrix";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeatmapFilters {
  model: string;
  repo: string;
  /** "active_grants" | "active_work" | "all" */
  status: string;
  windowDays: number;
  /** Dimension drill-down filters — applied via peer-share-dimensions endpoint. */
  source: string;
  language: string;
}

/** One row returned by /api/dashboard/peer-share-dimensions. */
interface DimensionRow {
  dimension_value: string;
  cost_millicents: number;
  event_count: number;
  trend: number | null;
}

/** Cached dimension options fetched for a specific shareId. */
interface DimensionOptions {
  models: string[];
  sources: string[];
  languages: string[];
}

interface TooltipState {
  cell: MatrixCell;
  peer: PeerMember;
  bucketLabel: string;
  x: number;
  y: number;
}

interface Props {
  /** The current user's ID — used to build the API request. */
  userId: string;
  /** Pre-populated model list for the filter dropdown (from dashboard data). */
  availableModels?: string[];
  /**
   * The peer_share.id to use for dimension drill-down queries.
   * When provided, the heatmap fetches available model/source/language
   * values from /api/dashboard/peer-share-dimensions without re-querying
   * raw events. Optional — dimension dropdowns are hidden when absent.
   */
  shareId?: string;
  /** URL params for filter initialisation (e.g. from searchParams). */
  initialFilters?: Partial<HeatmapFilters>;
}

const WINDOW_OPTIONS = [
  { label: "24h", value: 1 },
  { label: "3d",  value: 3 },
  { label: "7d",  value: 7 },
  { label: "14d", value: 14 },
];

const STATUS_OPTIONS: { label: string; value: HeatmapFilters["status"] }[] = [
  { label: "active grants",  value: "active_grants" },
  { label: "active work",    value: "active_work"   },
  { label: "all",            value: "all"            },
];

const DEFAULT_FILTERS: HeatmapFilters = {
  model:      "",
  repo:       "",
  status:     "active_grants",
  windowDays: 7,
  source:     "",
  language:   "",
};

// ─── Main Component ───────────────────────────────────────────────────────────

export function HeatmapTab({ userId, availableModels = [], shareId, initialFilters = {} }: Props): ReactElement {
  const [filters, setFilters] = useState<HeatmapFilters>({
    ...DEFAULT_FILTERS,
    ...initialFilters,
  });
  const [matrix, setMatrix] = useState<CollaborationMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dimensionOptions, setDimensionOptions] = useState<DimensionOptions | null>(null);
  const [dimensionsLoading, setDimensionsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Data loading ────────────────────────────────────────────────────────
  const load = useCallback(async (f: HeatmapFilters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ userId, windowDays: String(f.windowDays), status: f.status });
      if (f.model)    params.set("model", f.model);
      if (f.repo)     params.set("repo", f.repo);
      if (f.source)   params.set("source", f.source);
      if (f.language) params.set("language", f.language);
      const res = await fetch(`/api/dashboard/collaboration-matrix?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as CollaborationMatrix;
      setMatrix(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load collaboration matrix");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(filters); }, [load, filters]);

  // ── Dimension options loading ────────────────────────────────────────────
  // Fetches available model/source/language values from the materialised
  // peer_share_daily_agg_by_* tables via the new dimensions endpoint.
  // Only runs when a shareId is provided. Does NOT re-query raw events.
  const loadDimensions = useCallback(async (sid: string, windowDays: number) => {
    setDimensionsLoading(true);
    const since = new Date(Date.now() - windowDays * 86_400_000)
      .toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    try {
      const [modelRes, sourceRes, langRes] = await Promise.all([
        fetch(`/api/dashboard/peer-share-dimensions?shareId=${sid}&dimension=model&since=${since}&until=${until}`),
        fetch(`/api/dashboard/peer-share-dimensions?shareId=${sid}&dimension=source&since=${since}&until=${until}`),
        fetch(`/api/dashboard/peer-share-dimensions?shareId=${sid}&dimension=language&since=${since}&until=${until}`),
      ]);

      const [modelData, sourceData, langData] = await Promise.all([
        modelRes.ok  ? (modelRes.json()  as Promise<{ rows: DimensionRow[] }>) : Promise.resolve({ rows: [] }),
        sourceRes.ok ? (sourceRes.json() as Promise<{ rows: DimensionRow[] }>) : Promise.resolve({ rows: [] }),
        langRes.ok   ? (langRes.json()   as Promise<{ rows: DimensionRow[] }>) : Promise.resolve({ rows: [] }),
      ]);

      setDimensionOptions({
        models:    modelData.rows.map((r) => r.dimension_value).filter(Boolean),
        sources:   sourceData.rows.map((r) => r.dimension_value).filter(Boolean),
        languages: langData.rows.map((r) => r.dimension_value).filter(Boolean),
      });
    } catch {
      // Non-fatal — dimension dropdowns remain hidden.
    } finally {
      setDimensionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (shareId) void loadDimensions(shareId, filters.windowDays);
  }, [shareId, filters.windowDays, loadDimensions]);

  // Persist filters to URL without full navigation.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (filters.model)    url.searchParams.set("hm_model",    filters.model);    else url.searchParams.delete("hm_model");
    if (filters.repo)     url.searchParams.set("hm_repo",     filters.repo);     else url.searchParams.delete("hm_repo");
    if (filters.source)   url.searchParams.set("hm_source",   filters.source);   else url.searchParams.delete("hm_source");
    if (filters.language) url.searchParams.set("hm_language", filters.language); else url.searchParams.delete("hm_language");
    if (filters.status !== DEFAULT_FILTERS.status)
      url.searchParams.set("hm_status", filters.status);
    else url.searchParams.delete("hm_status");
    if (filters.windowDays !== DEFAULT_FILTERS.windowDays)
      url.searchParams.set("hm_win", String(filters.windowDays));
    else url.searchParams.delete("hm_win");
    window.history.replaceState(null, "", url.toString());
  }, [filters]);

  // ── CSV export ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!matrix || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ userId, windowDays: String(filters.windowDays), status: filters.status, format: "csv" });
      if (filters.model) params.set("model", filters.model);
      if (filters.repo)  params.set("repo", filters.repo);
      const res = await fetch(`/api/dashboard/collaboration-matrix?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `collaboration-matrix-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      console.error("CSV export failed:", e);
    } finally {
      setExporting(false);
    }
  }, [matrix, exporting, userId, filters]);

  // ── Render states ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ marginTop: space.x4, color: palette.textDim, fontSize: 13 }}>
        Loading collaboration matrix…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ marginTop: space.x4, color: palette.red, fontSize: 13 }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ marginTop: space.x4 }} ref={containerRef}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: space.x3, flexWrap: "wrap", gap: space.x2 }}>
        <div>
          <span style={{ fontSize: 12, color: palette.text, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            peer collaboration heatmap
          </span>
          <span style={{ fontSize: 11, color: palette.textDim, marginLeft: 8 }}>
            cost_millicents per hour · {matrix?.peers.length ?? 0} peers · {filters.windowDays}d window
            {dimensionsLoading && <span style={{ marginLeft: 8, color: palette.textMute }}>(loading dimensions…)</span>}
          </span>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting || !matrix || matrix.cells.length === 0}
          style={{
            fontSize: 11,
            padding: "5px 12px",
            borderRadius: radius.sm,
            border: `1px solid ${palette.border}`,
            background: "transparent",
            color: exporting ? palette.textDim : palette.cyan,
            cursor: exporting ? "default" : "pointer",
            letterSpacing: "0.4px",
            textTransform: "uppercase",
          }}
        >
          {exporting ? "exporting…" : "export csv"}
        </button>
      </div>

      {/* Filter bar */}
      <FilterBar
        filters={filters}
        availableModels={availableModels}
        dimensionOptions={dimensionOptions}
        onChange={setFilters}
      />

      {/* Matrix */}
      {!matrix || matrix.peers.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <MatrixGrid
            matrix={matrix}
            onHover={setTooltip}
          />
          {/* Legend */}
          <CostLegend max={matrix.maxCostMillicents} />
        </>
      )}

      {/* Tooltip (portal-like absolute positioning) */}
      {tooltip && (
        <HoverTooltip
          tooltip={tooltip}
          onDismiss={() => setTooltip(null)}
        />
      )}
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar({
  filters,
  availableModels,
  dimensionOptions,
  onChange,
}: {
  filters: HeatmapFilters;
  availableModels: string[];
  dimensionOptions: DimensionOptions | null;
  onChange: (f: HeatmapFilters) => void;
}): ReactElement {
  const update = (patch: Partial<HeatmapFilters>) => onChange({ ...filters, ...patch });

  const selectStyle: React.CSSProperties = {
    fontSize: 11,
    padding: "4px 8px",
    borderRadius: radius.sm,
    border: `1px solid ${palette.border}`,
    background: palette.bgSurface,
    color: palette.text,
    cursor: "pointer",
  };

  // Merge model list: prefer dimensionOptions (from materialised tables) if
  // available; fall back to the prop-supplied availableModels.
  const modelList = dimensionOptions?.models.length
    ? dimensionOptions.models
    : availableModels;

  const hasNonDefaultFilter =
    !!(filters.model || filters.repo || filters.source || filters.language) ||
    filters.status !== DEFAULT_FILTERS.status ||
    filters.windowDays !== DEFAULT_FILTERS.windowDays;

  return (
    <div style={{ display: "flex", gap: space.x2, flexWrap: "wrap", alignItems: "center", marginBottom: space.x3 }}>
      {/* Window selector */}
      <FilterGroup label="window">
        {WINDOW_OPTIONS.map((opt) => (
          <ChipButton
            key={opt.value}
            active={filters.windowDays === opt.value}
            onClick={() => update({ windowDays: opt.value })}
          >
            {opt.label}
          </ChipButton>
        ))}
      </FilterGroup>

      {/* Peer status */}
      <FilterGroup label="peers">
        {STATUS_OPTIONS.map((opt) => (
          <ChipButton
            key={opt.value}
            active={filters.status === opt.value}
            onClick={() => update({ status: opt.value })}
          >
            {opt.label}
          </ChipButton>
        ))}
      </FilterGroup>

      {/* Model filter — from materialised dimension table when shareId present */}
      {modelList.length > 0 && (
        <FilterGroup label="model">
          <select
            value={filters.model}
            onChange={(e) => update({ model: e.target.value })}
            style={selectStyle}
          >
            <option value="">all models</option>
            {modelList.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </FilterGroup>
      )}

      {/* Source filter — populated from peer_share_daily_agg_by_source */}
      {dimensionOptions && dimensionOptions.sources.length > 0 && (
        <FilterGroup label="source">
          <select
            value={filters.source}
            onChange={(e) => update({ source: e.target.value })}
            style={selectStyle}
          >
            <option value="">all sources</option>
            {dimensionOptions.sources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FilterGroup>
      )}

      {/* Language filter — populated from peer_share_daily_agg_by_language */}
      {dimensionOptions && dimensionOptions.languages.length > 0 && (
        <FilterGroup label="language">
          <select
            value={filters.language}
            onChange={(e) => update({ language: e.target.value })}
            style={selectStyle}
          >
            <option value="">all languages</option>
            {dimensionOptions.languages.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </FilterGroup>
      )}

      {/* Repo filter */}
      <FilterGroup label="repo">
        <input
          type="text"
          placeholder="filter by repo…"
          value={filters.repo}
          onChange={(e) => update({ repo: e.target.value })}
          style={{
            ...selectStyle,
            width: 160,
            outline: "none",
          }}
        />
      </FilterGroup>

      {/* Clear all */}
      {hasNonDefaultFilter && (
        <button
          onClick={() => onChange(DEFAULT_FILTERS)}
          style={{
            fontSize: 10,
            padding: "4px 8px",
            borderRadius: radius.sm,
            border: `1px solid ${palette.border}`,
            background: "transparent",
            color: palette.textDim,
            cursor: "pointer",
            textTransform: "uppercase",
            letterSpacing: "0.4px",
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <div style={{ display: "flex", gap: 4 }}>{children}</div>
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "4px 10px",
        borderRadius: radius.sm,
        border: `1px solid ${active ? palette.purple : palette.border}`,
        background: active ? `${palette.purple}18` : "transparent",
        color: active ? palette.purple : palette.textDim,
        cursor: "pointer",
        transition: "all 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ─── Matrix grid ──────────────────────────────────────────────────────────────

/** Number of X-axis (bucket) columns to show before switching to day-granularity labels. */
const LABEL_STRIDE_THRESHOLD = 48; // > 48h → show day labels, not hour labels

function MatrixGrid({
  matrix,
  onHover,
}: {
  matrix: CollaborationMatrix;
  onHover: (t: TooltipState | null) => void;
}): ReactElement {
  const { peers, buckets, cells, maxCostMillicents } = matrix;

  // Build lookup: "ownerId::hourBucket" → MatrixCell
  const cellMap = new Map<string, MatrixCell>();
  for (const cell of cells) {
    cellMap.set(`${cell.ownerId}::${cell.hourBucket}`, cell);
  }

  // Build peer lookup
  const peerMap = new Map<string, PeerMember>(peers.map((p) => [p.ownerId, p]));

  // X-axis label stride — avoid rendering 168 labels for 7d.
  const stride = buckets.length > LABEL_STRIDE_THRESHOLD ? 24 : (buckets.length > 24 ? 6 : 1);

  // Cell dimensions — shrink when many buckets.
  const cellW = buckets.length > 100 ? 5 : buckets.length > 48 ? 8 : 14;
  const cellH = 22;
  const cellGap = 1;

  function cellColor(cost: number): string {
    if (cost <= 0 || maxCostMillicents === 0) return palette.bgRaised;
    const intensity = Math.min(cost / maxCostMillicents, 1);
    // Interpolate: dim purple (#1a1020) → vivid purple (#C99CFF)
    const r = Math.round(30 + intensity * (201 - 30));
    const g = Math.round(10 + intensity * (156 - 10));
    const b = Math.round(40 + intensity * (255 - 40));
    return `rgb(${r},${g},${b})`;
  }

  const thBase: React.CSSProperties = {
    padding: "2px 4px",
    color: palette.textDim,
    fontWeight: 500,
    textAlign: "left",
    fontSize: 10,
    whiteSpace: "nowrap",
    borderBottom: `1px solid ${palette.border}`,
  };

  return (
    <div style={{ overflowX: "auto", overflowY: "visible" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: cellGap, tableLayout: "fixed" }}>
        <thead>
          <tr>
            {/* Peer label column header */}
            <th style={{ ...thBase, minWidth: 140, maxWidth: 140 }}>peer</th>
            {/* Bucket columns */}
            {buckets.map((bucket, i) => {
              const showLabel = i % stride === 0;
              const label = showLabel ? formatBucketLabel(bucket, stride) : "";
              return (
                <th
                  key={bucket}
                  style={{
                    ...thBase,
                    width: cellW,
                    minWidth: cellW,
                    maxWidth: cellW,
                    textAlign: "center",
                    overflow: "hidden",
                    padding: 0,
                    fontSize: 9,
                    color: palette.textMute,
                    verticalAlign: "bottom",
                  }}
                  title={bucket}
                >
                  {label}
                </th>
              );
            })}
            {/* Total column */}
            <th style={{ ...thBase, minWidth: 70, textAlign: "right" }}>total cost</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((peer) => {
            const rowTotal = cells
              .filter((c) => c.ownerId === peer.ownerId)
              .reduce((s, c) => s + c.costMillicents, 0);

            return (
              <tr key={peer.ownerId}>
                {/* Peer label */}
                <td
                  style={{
                    fontSize: 11,
                    color: peer.grantActive ? palette.text : palette.textDim,
                    padding: "2px 6px 2px 0",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 140,
                    verticalAlign: "middle",
                  }}
                  title={peer.maskedEmail}
                >
                  {peer.maskedEmail}
                  {!peer.grantActive && (
                    <span style={{ fontSize: 9, color: palette.textMute, marginLeft: 4 }}>(revoked)</span>
                  )}
                </td>

                {/* Cells */}
                {buckets.map((bucket) => {
                  const cell = cellMap.get(`${peer.ownerId}::${bucket}`);
                  const cost = cell?.costMillicents ?? 0;
                  return (
                    <td
                      key={bucket}
                      style={{
                        width: cellW,
                        minWidth: cellW,
                        maxWidth: cellW,
                        height: cellH,
                        background: cellColor(cost),
                        borderRadius: 2,
                        cursor: cell ? "pointer" : "default",
                        transition: "filter 0.1s",
                        verticalAlign: "middle",
                      }}
                      title={cell ? `${peer.maskedEmail} · ${bucket} · ${cell.costMillicents}mc` : ""}
                      onMouseEnter={(e) => {
                        if (!cell) return;
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        onHover({
                          cell,
                          peer,
                          bucketLabel: bucket,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }}
                      onMouseLeave={() => onHover(null)}
                    />
                  );
                })}

                {/* Total */}
                <td
                  style={{
                    fontSize: 11,
                    color: rowTotal > 0 ? palette.text : palette.textMute,
                    textAlign: "right",
                    padding: "2px 0 2px 8px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {rowTotal > 0 ? `${fmtMillicents(rowTotal)}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Cost legend ──────────────────────────────────────────────────────────────

function CostLegend({ max }: { max: number }): ReactElement {
  const stops = [0, 0.25, 0.5, 0.75, 1.0];

  function cellColor(intensity: number): string {
    const r = Math.round(30 + intensity * (201 - 30));
    const g = Math.round(10 + intensity * (156 - 10));
    const b = Math.round(40 + intensity * (255 - 40));
    return `rgb(${r},${g},${b})`;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: space.x3, marginBottom: space.x2 }}>
      <span style={{ fontSize: 10, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px" }}>cost intensity</span>
      <div style={{ display: "flex", gap: 3 }}>
        {stops.map((s) => (
          <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <div style={{ width: 16, height: 12, borderRadius: 2, background: cellColor(s) }} />
            <span style={{ fontSize: 9, color: palette.textMute }}>{fmtMillicents(Math.round(s * max))}</span>
          </div>
        ))}
      </div>
      <span style={{ fontSize: 10, color: palette.textMute }}>per hour bucket</span>
    </div>
  );
}

// ─── Hover tooltip ────────────────────────────────────────────────────────────

function HoverTooltip({ tooltip, onDismiss }: { tooltip: TooltipState; onDismiss: () => void }): ReactElement {
  const { cell, peer, bucketLabel } = tooltip;

  const topModels = Object.entries(cell.modelBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return (
    <div
      style={{
        position: "fixed",
        top: Math.max(8, tooltip.y - 180),
        left: Math.min(tooltip.x, (typeof window !== "undefined" ? window.innerWidth : 800) - 260),
        zIndex: 2000,
        background: palette.bgSurface,
        border: `1px solid ${palette.border}`,
        borderRadius: radius.md,
        padding: "12px 14px",
        minWidth: 220,
        maxWidth: 260,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        fontSize: 12,
        pointerEvents: "none",
      }}
      onMouseLeave={onDismiss}
    >
      <div style={{ color: palette.purple, fontWeight: 600, marginBottom: 6, fontSize: 12 }}>
        {peer.maskedEmail}
      </div>
      <div style={{ color: palette.textDim, fontSize: 10, marginBottom: 8 }}>
        {formatBucketLabel(bucketLabel, 1)} UTC
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", marginBottom: 8 }}>
        <TooltipMetric label="cost" value={fmtMillicents(cell.costMillicents)} accent={palette.purple} />
        <TooltipMetric label="events" value={String(cell.eventCount)} accent={palette.cyan} />
        <TooltipMetric label="tokens" value={fmtTokens(cell.totalTokens)} accent={palette.amber} />
        <TooltipMetric label="source" value={cell.topSource ?? "—"} accent={palette.green} />
      </div>

      {topModels.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 4 }}>
            top models
          </div>
          {topModels.map(([model, cost]) => (
            <div key={model} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: palette.text, padding: "1px 0" }}>
              <span style={{ color: palette.textDim, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130, whiteSpace: "nowrap" }}>{model}</span>
              <span style={{ color: palette.purple }}>{fmtMillicents(cost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TooltipMetric({ label, value, accent }: { label: string; value: string; accent: string }): ReactElement {
  return (
    <div>
      <div style={{ fontSize: 9, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.4px" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: accent }}>{value}</div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState(): ReactElement {
  return (
    <div style={{
      marginTop: space.x4,
      padding: 32,
      textAlign: "center",
      color: palette.textDim,
      fontSize: 13,
      border: `1px dashed ${palette.border}`,
      borderRadius: radius.lg,
    }}>
      <div style={{ fontSize: 28, marginBottom: 12 }}>⬛</div>
      <div style={{ color: palette.text, fontWeight: 600, marginBottom: 6 }}>No collaboration data</div>
      <div style={{ fontSize: 12, maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>
        No peers have granted you access yet, or there&apos;s no activity in the selected window.
        Share your dashboard via peer-share to start seeing team collaboration patterns.
      </div>
      <a
        href="/share"
        style={{ display: "inline-block", marginTop: 16, color: palette.purple, fontSize: 12, textDecoration: "none" }}
      >
        Set up peer-share →
      </a>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtMillicents(mc: number): string {
  if (mc === 0) return "0";
  if (mc < 1000) return `${mc}mc`;
  if (mc < 100_000) return `${(mc / 1000).toFixed(1)}¢`;
  return `$${(mc / 100_000).toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatBucketLabel(iso: string, stride: number): string {
  const d = new Date(iso);
  if (stride >= 24) {
    // Day-level label: "Jun 29"
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  if (stride >= 6) {
    // 6h label: "Jun 29 06"
    const h = String(d.getUTCHours()).padStart(2, "0");
    const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return `${day} ${h}h`;
  }
  // Hourly: "14:00"
  return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
}
