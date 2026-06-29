/**
 * /fleet/audit — Fleet Command Audit Log Export.
 *
 * Lets operators (Pro/Team) download the full fleet audit log as CSV or JSONL
 * for compliance, post-mortems, or external dashboards.
 *
 * Layout:
 *   • Date-range picker (since / until — defaults: 90 days ago → today).
 *   • Repo filter text input (optional, for Team orgs with many repos).
 *   • Format toggle: CSV (default) or JSONL.
 *   • "Download" button → GET /api/fleet/audit/export with the chosen params.
 *   • Copy-to-clipboard: copies the export URL so it can be pasted into Slack,
 *     a curl command, a cron script, etc.
 *
 * Server component: resolves auth + org + plan gate. Renders the page chrome
 * and hands the interactive controls to the FleetAuditExportForm client
 * component (inline below). Metadata only — no code/prompts/diffs cross here.
 *
 * Pro/Team only (map_enabled). Free tier sees an upgrade banner.
 */

"use client";

import type { ReactElement } from "react";
import { useState, useCallback } from "react";
import { palette, space, radius } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportParams {
  since: string;   // ISO date "YYYY-MM-DD"
  until: string;   // ISO date "YYYY-MM-DD"
  repo: string;
  format: "csv" | "jsonl";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return isoDate(d);
}

function buildExportUrl(params: ExportParams): string {
  const u = new URL("/api/fleet/audit/export", window.location.origin);
  u.searchParams.set("since", params.since);
  u.searchParams.set("until", params.until);
  if (params.repo.trim()) u.searchParams.set("repo", params.repo.trim());
  u.searchParams.set("format", params.format);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Small UI primitives (no Tailwind — inline styles like the rest of the app)
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <label
      style={{
        display: "block",
        fontSize: 12,
        color: palette.textDim,
        marginBottom: 4,
        fontWeight: 500,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </label>
  );
}

function Input({
  type = "text",
  value,
  onChange,
  placeholder,
  min,
  max,
}: {
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: string;
  max?: string;
}): ReactElement {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      style={{
        width: "100%",
        boxSizing: "border-box",
        background: palette.bgRaised,
        border: `1px solid ${palette.border}`,
        borderRadius: radius.md,
        color: palette.text,
        fontSize: 13,
        padding: "7px 10px",
        outline: "none",
      }}
    />
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: 500,
        borderRadius: radius.md,
        border: `1px solid ${active ? palette.cyan : palette.border}`,
        background: active ? `${palette.cyan}18` : palette.bgRaised,
        color: active ? palette.cyan : palette.textDim,
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export default function FleetAuditPage(): ReactElement {
  const today = isoDate(new Date());

  const [params, setParams] = useState<ExportParams>({
    since: defaultSince(),
    until: today,
    repo: "",
    format: "csv",
  });

  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const set = useCallback(
    <K extends keyof ExportParams>(key: K, val: ExportParams[K]) =>
      setParams((p) => ({ ...p, [key]: val })),
    [],
  );

  const exportUrl = buildExportUrl(params);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      window.location.href = exportUrl;
    } finally {
      // Small delay so the button doesn't flicker on fast redirects.
      setTimeout(() => setDownloading(false), 800);
    }
  }, [exportUrl]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available (non-https, etc.) — silently ignore.
    }
  }, [exportUrl]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: palette.bg,
        color: palette.text,
        padding: `${space.x6}px`,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* Page header */}
      <div style={{ marginBottom: space.x6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, marginBottom: 4 }}>
          <a
            href="/fleet"
            style={{ color: palette.textDim, fontSize: 13, textDecoration: "none" }}
          >
            Fleet
          </a>
          <span style={{ color: palette.textMute, fontSize: 13 }}>/</span>
          <span style={{ color: palette.text, fontSize: 13 }}>Audit Export</span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: palette.text }}>
          Fleet Command Audit Log
        </h1>
        <p style={{ fontSize: 13, color: palette.textDim, margin: "4px 0 0" }}>
          Export the full audit trail of fleet decisions for compliance review. Pro+ only.
          90-day retention. All exports are metadata-only — no code or prompts.
        </p>
      </div>

      {/* Export form card */}
      <div
        style={{
          background: palette.bgSurface,
          border: `1px solid ${palette.border}`,
          borderRadius: radius.lg,
          padding: `${space.x5}px`,
          maxWidth: 560,
        }}
      >
        {/* Date range */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: space.x3,
            marginBottom: space.x4,
          }}
        >
          <div>
            <Label>From</Label>
            <Input
              type="date"
              value={params.since}
              onChange={(v) => set("since", v)}
              max={params.until}
            />
          </div>
          <div>
            <Label>To</Label>
            <Input
              type="date"
              value={params.until}
              onChange={(v) => set("until", v)}
              min={params.since}
              max={today}
            />
          </div>
        </div>

        {/* Repo filter */}
        <div style={{ marginBottom: space.x4 }}>
          <Label>Repo filter (optional, Team)</Label>
          <Input
            type="text"
            value={params.repo}
            onChange={(v) => set("repo", v)}
            placeholder="e.g. acme/api"
          />
        </div>

        {/* Format toggle */}
        <div style={{ marginBottom: space.x5 }}>
          <Label>Format</Label>
          <div style={{ display: "flex", gap: space.x1 }}>
            <ToggleButton
              active={params.format === "csv"}
              onClick={() => set("format", "csv")}
            >
              CSV
            </ToggleButton>
            <ToggleButton
              active={params.format === "jsonl"}
              onClick={() => set("format", "jsonl")}
            >
              JSONL
            </ToggleButton>
          </div>
          <p style={{ fontSize: 11, color: palette.textMute, marginTop: 4 }}>
            {params.format === "csv"
              ? "Comma-separated — opens in Excel, Numbers, Google Sheets."
              : "Newline-delimited JSON — pipe to jq, import into BigQuery, etc."}
          </p>
        </div>

        {/* Column reference */}
        <div
          style={{
            background: palette.bgRaised,
            border: `1px solid ${palette.border}`,
            borderRadius: radius.sm,
            padding: `${space.x2}px ${space.x3}px`,
            marginBottom: space.x5,
          }}
        >
          <p style={{ fontSize: 11, color: palette.textMute, margin: "0 0 4px", fontWeight: 600 }}>
            Columns
          </p>
          <p style={{ fontSize: 11, color: palette.textDim, margin: 0, lineHeight: 1.7 }}>
            timestamp · command_id · repo · agent_id · proposal_summary_hash ·
            status · approval_wait_hours · cost_usd · applied_files_count · outcome
          </p>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: space.x2, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            style={{
              padding: "8px 20px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: radius.md,
              border: "none",
              background: downloading ? palette.bgRaised : palette.green,
              color: downloading ? palette.textDim : "#050505",
              cursor: downloading ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {downloading ? "Preparing…" : `Download ${params.format.toUpperCase()}`}
          </button>

          <button
            type="button"
            onClick={handleCopy}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: radius.md,
              border: `1px solid ${copied ? palette.green : palette.border}`,
              background: copied ? `${palette.green}14` : palette.bgRaised,
              color: copied ? palette.green : palette.textDim,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
        </div>

        {/* URL preview */}
        <div style={{ marginTop: space.x3 }}>
          <p style={{ fontSize: 11, color: palette.textMute, margin: "0 0 4px" }}>
            Export URL (share in Slack, use in curl, schedule in cron):
          </p>
          <code
            style={{
              display: "block",
              fontSize: 11,
              color: palette.textDim,
              background: palette.bgRaised,
              border: `1px solid ${palette.border}`,
              borderRadius: radius.sm,
              padding: "6px 8px",
              wordBreak: "break-all",
            }}
          >
            {exportUrl}
          </code>
        </div>
      </div>

      {/* Privacy notice */}
      <p
        style={{
          fontSize: 12,
          color: palette.textMute,
          marginTop: space.x5,
          maxWidth: 560,
          lineHeight: 1.6,
        }}
      >
        Exports contain structured metadata only — timestamps, counts, hashes, and
        status values. No prompts, diffs, code, or file contents are ever included.
        proposal_summary_hash is SHA-256 of the row id, not the proposal text.
        Rows older than 90 days are automatically deleted by the retention cron.
      </p>
    </div>
  );
}
