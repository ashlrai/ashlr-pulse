"use client";

/**
 * LivePulse — small "live" indicator wired to /api/stream.
 *
 * Subscribes via EventSource on mount, shows last-tick time + a green
 * dot when the stream is connected. Drops to amber when ticks stop
 * arriving (more than 45s since last tick). Reconnects automatically
 * via the browser's built-in EventSource retry logic.
 */

import { useEffect, useState } from "react";
import { palette } from "@/lib/theme";

interface Tick {
  ts: string;
  events_24h: number;
  tokens_24h: number;
  cents_24h: number;
}

export function LivePulse() {
  const [last, setLast] = useState<Tick | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const es = new EventSource("/api/stream", { withCredentials: true });
    const onTick = (e: MessageEvent) => {
      try {
        const t = JSON.parse(e.data) as Tick;
        setLast(t);
        setError(false);
      } catch {
        // Ignore malformed payloads.
      }
    };
    es.addEventListener("tick", onTick);
    es.onerror = () => setError(true);

    const refresh = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      es.removeEventListener("tick", onTick);
      es.close();
      clearInterval(refresh);
    };
  }, []);

  if (!last && !error) return null;

  const ageMs = last ? now - new Date(last.ts).getTime() : Infinity;
  const stale = ageMs > 45_000 || error;
  const color = stale ? palette.amber : palette.green;
  const label = error
    ? "live · disconnected"
    : !last
      ? "live · connecting"
      : `live · ${formatAge(Math.max(0, Math.round(ageMs / 1000)))}`;

  return (
    <span
      title={last ? `${last.events_24h} events · ${last.tokens_24h.toLocaleString()} tokens · ${(last.cents_24h / 100).toFixed(2)} USD (last 24h)` : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        background: stale ? "transparent" : "rgba(124,255,160,0.06)",
        border: `1px solid ${stale ? palette.border : "rgba(124,255,160,0.3)"}`,
        borderRadius: 999,
        color,
        fontSize: 11,
        letterSpacing: "0.3px",
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: "50%",
          background: color,
          animation: stale ? "none" : "live-tick 1.6s ease-in-out infinite",
          boxShadow: stale ? "none" : `0 0 6px ${color}`,
        }}
      />
      {label}
    </span>
  );
}

function formatAge(s: number): string {
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
