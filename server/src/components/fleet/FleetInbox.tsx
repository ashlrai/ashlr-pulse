"use client";

/**
 * FleetInbox.tsx — the operator's live view of the fleet_command queue.
 *
 * Renders the cloud→local command queue newest-first with per-status header
 * badges, and lets the operator CANCEL a still-pending command before the
 * daemon claims it (POST /api/fleet/inbox/[id] with { action: "cancel" }).
 *
 * Receives the first page server-side (initialCommands / initialCounts) so the
 * page is useful on first paint with zero client round-trips, then polls every
 * few seconds to watch the queue drain. Polling pauses when the tab is hidden.
 *
 * Privacy floor: every field rendered here is metadata only — command kind,
 * target repo, status, timestamps, claimer id, and a short error string. The
 * payload/result bags are NOT surfaced (they're sanitised server-side and not
 * needed for queue triage).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { palette, space, radius } from "@/lib/theme";
import type { FleetCommand, FleetCommandStatus } from "@/lib/graph-types";
import type { StatusCounts } from "@/lib/fleet-inbox-db";

interface Props {
  initialCommands: FleetCommand[];
  initialCounts: StatusCounts;
}

const REFRESH_MS = 5_000;

const STATUS_COLOR: Record<FleetCommandStatus, string> = {
  pending: palette.amber,
  claimed: palette.cyan,
  done: palette.green,
  failed: palette.red,
};

const STATUS_ORDER: FleetCommandStatus[] = ["pending", "claimed", "done", "failed"];

function fmtWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

interface InboxResponse {
  commands: FleetCommand[];
  counts: StatusCounts;
}

export function FleetInbox({ initialCommands, initialCounts }: Props): ReactElement {
  const [commands, setCommands] = useState<FleetCommand[]>(initialCommands);
  const [counts, setCounts] = useState<StatusCounts>(initialCounts);
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/fleet/inbox", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      const data: InboxResponse = await res.json();
      setCommands(data.commands ?? []);
      setCounts(data.counts ?? initialCounts);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "fetch failed");
    }
  }, [initialCounts]);

  useEffect(() => {
    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        if (!document.hidden) await poll();
        schedule();
      }, REFRESH_MS);
    };
    schedule();

    const onVisibility = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  const cancel = useCallback(async (id: string) => {
    setCancelling((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/fleet/inbox/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr((body as { error?: string }).error ?? `cancel failed (HTTP ${res.status})`);
        return;
      }
      await poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "cancel failed");
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [poll]);

  return (
    <div>
      {/* Status-count badges */}
      <div style={{ display: "flex", gap: space.x2, flexWrap: "wrap", marginBottom: space.x3 }}>
        {STATUS_ORDER.map((s) => (
          <span
            key={s}
            style={{
              fontSize: 12,
              padding: "3px 10px",
              borderRadius: radius.sm,
              border: `1px solid ${palette.border}`,
              color: STATUS_COLOR[s],
              background: palette.bgSurface,
            }}
          >
            {s} <strong style={{ color: palette.text }}>{counts[s]}</strong>
          </span>
        ))}
      </div>

      {err && (
        <p style={{ fontSize: 12, color: palette.red, margin: `0 0 ${space.x2}px` }}>
          {err}
        </p>
      )}

      {commands.length === 0 ? (
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          No commands yet. Assign work from the Map or Health Radar.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: space.x1 }}>
          {commands.map((c) => (
            <li
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.x3,
                padding: `${space.x2}px ${space.x3}px`,
                border: `1px solid ${palette.border}`,
                borderRadius: radius.md,
                background: palette.bgSurface,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.x2 }}>
                  <span style={{ color: STATUS_COLOR[c.status], fontSize: 11, textTransform: "uppercase", letterSpacing: "0.4px" }}>
                    {c.status}
                  </span>
                  <code style={{ color: palette.cyan, fontSize: 13 }}>{c.kind}</code>
                  {c.target && (
                    <span style={{ color: palette.textDim, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.target}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: palette.textMute, marginTop: 2 }}>
                  created {fmtWhen(c.createdAt)}
                  {c.claimedBy ? ` · claimed by ${c.claimedBy}` : ""}
                  {c.error ? ` · ${c.error}` : ""}
                </div>
              </div>
              {c.status === "pending" && (
                <button
                  type="button"
                  onClick={() => cancel(c.id)}
                  disabled={cancelling.has(c.id)}
                  style={{
                    fontSize: 12,
                    color: palette.red,
                    background: "transparent",
                    border: `1px solid ${palette.border}`,
                    borderRadius: radius.sm,
                    padding: "4px 10px",
                    cursor: cancelling.has(c.id) ? "default" : "pointer",
                    opacity: cancelling.has(c.id) ? 0.5 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {cancelling.has(c.id) ? "cancelling…" : "cancel"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
