"use client";

/**
 * InsightsDrawer.tsx — slide-in drawer that fetches cost-drift + anomalies
 * in parallel and renders a "spend trend" card with trend arrows +
 * recommendations.
 *
 * Opens via a trigger button rendered inline. Fetches lazily on first open
 * so the dashboard shell pays no extra cost on initial load.
 *
 * Data sources (fetched in parallel):
 *   • GET /api/insights/cost-drift → CostDriftResponse
 *   • Anomalies are derived client-side from the drift data (no extra fetch)
 *
 * Privacy: only aggregate + enum data is displayed — same floor as the API.
 */

import { useState, useCallback, useEffect } from "react";
import type { ReactElement } from "react";
import { palette, space, radius } from "@/lib/theme";
import { Card, CardHeader } from "@/components/ui/Card";

// ─── API response types (mirrors cost-drift route) ─────────────────────────

interface DriftForecast {
  byDay: number[];
  slope: number;
  rSquared: number;
}

interface AnomalousShift {
  key: string;
  kind: "source" | "model";
  pct: number;
}

interface CostDriftResponse {
  sourceShift: Record<string, number>;
  modelShift: Record<string, number>;
  predictedDrift7d: Record<string, DriftForecast>;
  recommendation: string;
  anomalousShifts: AnomalousShift[];
  meta: {
    windowDays: number;
    totalPrevMillicents: number;
    totalCurrMillicents: number;
    computedAt: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function pctLabel(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function trendArrow(pct: number): string {
  if (pct > 5)  return "↑";
  if (pct < -5) return "↓";
  return "→";
}

function trendColor(pct: number): string {
  // Growing cost = amber warning; shrinking = green good; flat = dim
  if (pct > 10)  return palette.amber;
  if (pct > 5)   return palette.amber;
  if (pct < -5)  return palette.green;
  return palette.textDim;
}

function friendlySource(src: string): string {
  const MAP: Record<string, string> = {
    cursor:        "Cursor",
    claude_code:   "Claude Code",
    copilot:       "Copilot",
    codex:         "Codex",
    wakatime:      "WakaTime",
    shell:         "Shell",
    git:           "Git",
    ashlr_plugin:  "ashlr-plugin",
    "ashlr-fleet": "ashlr-fleet",
  };
  return MAP[src] ?? src;
}

function millicentsToUsd(mc: number): string {
  return `$${(mc / 100_000).toFixed(2)}`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ShiftRow({
  label,
  pct,
}: {
  label: string;
  pct: number;
}): ReactElement {
  const color = trendColor(pct);
  const arrow = trendArrow(pct);

  return (
    <div
      style={{
        display:        "flex",
        justifyContent: "space-between",
        alignItems:     "center",
        padding:        `${space.x05}px 0`,
        borderBottom:   `1px solid ${palette.border}`,
      }}
    >
      <span style={{ color: palette.text, fontSize: 13 }}>{label}</span>
      <span
        style={{
          color,
          fontSize:   13,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {arrow} {pctLabel(pct)}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }): ReactElement {
  return (
    <div
      style={{
        fontSize:      10,
        color:         palette.textDim,
        textTransform: "uppercase",
        letterSpacing: "0.8px",
        fontWeight:    500,
        margin:        `${space.x3}px 0 ${space.x1}px`,
      }}
    >
      {children}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div style={{ color: palette.textMute, fontSize: 13, padding: `${space.x4}px 0` }}>
      Not enough history yet. Check back after 2 weeks of activity.
    </div>
  );
}

function LoadingSpinner(): ReactElement {
  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        padding:        space.x8,
        color:          palette.textDim,
        fontSize:       13,
      }}
    >
      Loading cost drift…
    </div>
  );
}

function ErrorState({ message }: { message: string }): ReactElement {
  return (
    <div style={{ color: palette.red, fontSize: 13, padding: `${space.x3}px 0` }}>
      Failed to load: {message}
    </div>
  );
}

// ─── Main drawer ─────────────────────────────────────────────────────────────

interface InsightsDrawerProps {
  /** Optional label for the trigger button. */
  triggerLabel?: string;
}

export function InsightsDrawer({
  triggerLabel = "Spend Insights",
}: InsightsDrawerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CostDriftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy fetch — only fires on first open.
  const fetchDrift = useCallback(async () => {
    if (data !== null) return; // already loaded
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/insights/cost-drift");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json: CostDriftResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [data]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    void fetchDrift();
  }, [fetchDrift]);

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const hasAnomalies = (data?.anomalousShifts?.length ?? 0) > 0;

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={handleOpen}
        style={{
          background:    "transparent",
          border:        `1px solid ${palette.border}`,
          borderRadius:  radius.md,
          color:         palette.textDim,
          cursor:        "pointer",
          fontSize:      11,
          fontFamily:    "inherit",
          letterSpacing: "0.4px",
          padding:       `${space.x05}px ${space.x2}px`,
          textTransform: "uppercase",
          transition:    "color 0.15s, border-color 0.15s",
          display:       "inline-flex",
          alignItems:    "center",
          gap:           space.x05,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = palette.cyan;
          (e.currentTarget as HTMLButtonElement).style.borderColor = palette.cyan;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = palette.textDim;
          (e.currentTarget as HTMLButtonElement).style.borderColor = palette.border;
        }}
        aria-label="Open spend insights drawer"
      >
        {/* Dot badge when anomalies detected */}
        {data && hasAnomalies && (
          <span
            style={{
              width:        6,
              height:       6,
              borderRadius: "50%",
              background:   palette.amber,
              display:      "inline-block",
            }}
          />
        )}
        {triggerLabel}
      </button>

      {/* Backdrop */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position:   "fixed",
            inset:      0,
            background: "rgba(0,0,0,0.55)",
            zIndex:     200,
          }}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Spend Insights"
        style={{
          position:        "fixed",
          top:             0,
          right:           0,
          bottom:          0,
          width:           380,
          maxWidth:        "90vw",
          background:      palette.bgSurface,
          borderLeft:      `1px solid ${palette.border}`,
          zIndex:          201,
          overflowY:       "auto",
          padding:         `${space.x5}px ${space.x5}px`,
          transform:       open ? "translateX(0)" : "translateX(100%)",
          transition:      "transform 0.25s cubic-bezier(0.2,0.7,0.2,1)",
          // Always rendered so the CSS transition fires cleanly.
        }}
      >
        {/* Header */}
        <div
          style={{
            display:        "flex",
            justifyContent: "space-between",
            alignItems:     "center",
            marginBottom:   space.x4,
          }}
        >
          <span
            style={{
              fontSize:      13,
              color:         palette.text,
              fontWeight:    600,
              letterSpacing: "0.3px",
              textTransform: "uppercase",
            }}
          >
            Spend Insights
          </span>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close insights drawer"
            style={{
              background:   "transparent",
              border:       "none",
              color:        palette.textDim,
              cursor:       "pointer",
              fontSize:     18,
              lineHeight:   1,
              padding:      `${space.x05}px ${space.x1}px`,
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        {loading && <LoadingSpinner />}
        {error && <ErrorState message={error} />}

        {!loading && !error && data && (
          <>
            {/* Meta summary */}
            <div
              style={{
                fontSize: 11,
                color:    palette.textMute,
                marginBottom: space.x3,
              }}
            >
              Last 14d vs prior 14d &nbsp;·&nbsp;
              prev {millicentsToUsd(data.meta.totalPrevMillicents)} →{" "}
              curr {millicentsToUsd(data.meta.totalCurrMillicents)}
            </div>

            {/* Recommendation card */}
            {data.recommendation && (
              <Card
                accent={hasAnomalies ? palette.amber : palette.cyan}
                pad="regular"
                style={{ marginBottom: space.x4 }}
              >
                <CardHeader title="Recommendation" />
                <p style={{ fontSize: 13, color: palette.text, lineHeight: 1.5, margin: 0 }}>
                  {data.recommendation}
                </p>
              </Card>
            )}

            {/* Source shift */}
            {Object.keys(data.sourceShift).length > 0 ? (
              <>
                <SectionTitle>Source Spend Shift (WoW)</SectionTitle>
                {Object.entries(data.sourceShift)
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .map(([src, pct]) => (
                    <ShiftRow key={src} label={friendlySource(src)} pct={pct} />
                  ))}
              </>
            ) : (
              <EmptyState />
            )}

            {/* Model shift */}
            {Object.keys(data.modelShift).length > 0 && (
              <>
                <SectionTitle>Model Mix Shift (WoW)</SectionTitle>
                {Object.entries(data.modelShift)
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .map(([model, pct]) => (
                    <ShiftRow key={model} label={model} pct={pct} />
                  ))}
              </>
            )}

            {/* 7d forecast */}
            {Object.keys(data.predictedDrift7d).length > 0 && (
              <>
                <SectionTitle>7-Day Projected Cost (by source)</SectionTitle>
                {Object.entries(data.predictedDrift7d).map(([src, forecast]) => {
                  const total = forecast.byDay.reduce((a, b) => a + b, 0);
                  const avgPerDay = total / forecast.byDay.length;
                  const slopeDir = forecast.slope > 0 ? "↑ growing" : forecast.slope < 0 ? "↓ declining" : "→ flat";
                  return (
                    <div
                      key={src}
                      style={{
                        display:        "flex",
                        justifyContent: "space-between",
                        alignItems:     "center",
                        padding:        `${space.x05}px 0`,
                        borderBottom:   `1px solid ${palette.border}`,
                      }}
                    >
                      <div>
                        <span style={{ fontSize: 13, color: palette.text }}>
                          {friendlySource(src)}
                        </span>
                        <span
                          style={{
                            fontSize:  11,
                            color:     palette.textMute,
                            marginLeft: space.x1,
                          }}
                        >
                          {slopeDir}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize:           13,
                          color:              forecast.slope > 50 ? palette.amber : palette.textDim,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        ~{millicentsToUsd(avgPerDay)}/day
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {/* Footer hint */}
            <div
              style={{
                fontSize:   10,
                color:      palette.textMute,
                marginTop:  space.x5,
                lineHeight: 1.5,
              }}
            >
              Computed {new Date(data.meta.computedAt).toLocaleString()}.
              Aggregates only — no prompts or code content.
            </div>
          </>
        )}

        {!loading && !error && !data && (
          <div style={{ color: palette.textMute, fontSize: 13 }}>
            Click to load spend insights…
          </div>
        )}
      </div>
    </>
  );
}
