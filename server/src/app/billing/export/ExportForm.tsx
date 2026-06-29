"use client";

/**
 * ExportForm — client component for the billing export page.
 *
 * Renders project picker + date range inputs, then triggers a
 * GET /api/billing/export download when the user submits.
 * No React state for form fields — native form elements + FormData.
 */

import { useState, type ReactElement, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Select, Input, Field } from "@/components/ui/Input";

export interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  projects: ProjectOption[];
}

export function ExportForm({ projects }: Props): ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRowCount(null);

    const fd = new FormData(e.currentTarget);
    const projectId = fd.get("projectId") as string;
    const since = fd.get("since") as string;
    const until = fd.get("until") as string;

    if (!projectId || !since || !until) {
      setErr("All fields are required.");
      setBusy(false);
      return;
    }

    const params = new URLSearchParams({ projectId, since, until });
    const url = `/api/billing/export?${params.toString()}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setErr(body.error ?? `Export failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }

      // Stream the CSV blob and trigger a browser download.
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const fnMatch = disposition.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1] : `engagement-export.csv`;

      // Count rows in the blob for feedback (subtract header line).
      const text = await blob.text();
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      setRowCount(Math.max(0, lines.length - 1));

      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <Field label="Project">
        <Select name="projectId" required disabled={busy}>
          <option value="">— select a project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="From (since)" hint="inclusive lower bound">
          <Input
            type="date"
            name="since"
            required
            disabled={busy}
            defaultValue={defaultSince()}
          />
        </Field>

        <Field label="To (until)" hint="inclusive upper bound">
          <Input
            type="date"
            name="until"
            required
            disabled={busy}
            defaultValue={defaultUntil()}
          />
        </Field>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
        <Button type="submit" variant="primary" disabled={busy || projects.length === 0}>
          {busy ? "Generating…" : "Download CSV"}
        </Button>

        {rowCount !== null && !busy && (
          <span style={{ fontSize: 12, color: "#7CFFA0" }}>
            {rowCount === 0 ? "No data for this range." : `${rowCount} row${rowCount === 1 ? "" : "s"} exported.`}
          </span>
        )}
      </div>

      {err && (
        <p style={{ marginTop: 12, fontSize: 12, color: "#ff6b6b" }}>{err}</p>
      )}

      {projects.length === 0 && (
        <p style={{ marginTop: 12, fontSize: 12, color: "#888" }}>
          No projects yet.{" "}
          <a href="/projects" style={{ color: "#7CD0FF" }}>Create a project</a>{" "}
          to enable billing exports.
        </p>
      )}
    </form>
  );
}

/** Default "since" = start of current calendar month. */
function defaultSince(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Default "until" = today. */
function defaultUntil(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
