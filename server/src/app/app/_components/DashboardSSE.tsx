"use client";

/**
 * DashboardSSE.tsx — client-side SSE subscriber for the /app dashboard.
 *
 * Connects to GET /api/app/live (optionally with ?as=<userId> for peer-share
 * views). As live events arrive, the component:
 *
 *   1. Parses the named SSE event type ("activity" | "anomaly" | "heartbeat").
 *   2. For "activity" events:
 *        - Merges the incoming events into a local ref-tracked snapshot.
 *        - Computes whether the new batch constitutes a "material" change:
 *            · event count differs by > 5 % from the current snapshot, OR
 *            · token total differs by > 5 %, OR
 *            · cost_millicents total differs by > 5 %.
 *        - On a material change, fires router.refresh() (Next.js App Router)
 *          which triggers a server revalidation without a full navigation.
 *        - Dispatches a custom DOM "pulse:activity" event so tab components
 *          can react immediately without waiting for a router refresh.
 *   3. For "anomaly" events:
 *        - Deduplicates by event_id (within the current SSE session).
 *        - Dispatches a custom DOM "pulse:anomaly" event that the Alerts tab
 *          listens to for live badge updates.
 *   4. For "heartbeat" events: no-op (keeps the connection alive).
 *
 * Also maintains the legacy /api/dashboard/subscribe connection for backwards
 * compatibility with components that still listen on that path.
 *
 * The component renders nothing — it is a pure side-effect hook component
 * dropped into the server page layout.
 *
 * Polling fallback
 * ────────────────
 * Individual tab components retain their existing polling behaviour.
 * The SSE path is purely additive — a missed or dropped broadcast just means
 * the next poll catches up.
 *
 * Privacy
 * ───────
 * Events received here have already been stripped by redactForBroadcast()
 * server-side. No prompts, completions, or raw spans ever reach this
 * component.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { FleetRealtimeEvent } from "@/lib/fleet-realtime";
import type { LiveActivityEvent, LiveAnomalyEvent } from "@/lib/dashboard-sse-broadcast";
import { deriveAnomalies } from "@/lib/realtime-anomaly";
import type { AnomalyContext } from "@/lib/realtime-anomaly";

interface Props {
  /** When set, subscribe to this user's events via peer-share scope. */
  asUserId?: string;
}

/** Minimum fractional change in any aggregate metric to trigger a refresh. */
const MATERIAL_DELTA_THRESHOLD = 0.05; // 5 %

interface EventSnapshot {
  count: number;
  tokens: number;      // tokens_total from LiveActivityEvent
  costMillicents: number;
}

function isMaterialChange(prev: EventSnapshot, incoming: LiveActivityEvent[]): boolean {
  if (incoming.length === 0) return false;

  const incomingCount = incoming.length;
  const incomingTokens = incoming.reduce(
    (sum, e) => sum + (e.tokens_total ?? 0),
    0,
  );
  const incomingCost = incoming.reduce(
    (sum, e) => sum + (e.cost_millicents ?? 0),
    0,
  );

  // Always consider the first batch material (prev is zero — avoids NaN).
  if (prev.count === 0 && prev.tokens === 0 && prev.costMillicents === 0) {
    return incomingCount > 0 || incomingTokens > 0 || incomingCost > 0;
  }

  const countDelta   = prev.count          > 0 ? incomingCount  / prev.count          : 1;
  const tokensDelta  = prev.tokens         > 0 ? incomingTokens / prev.tokens         : 1;
  const costDelta    = prev.costMillicents > 0 ? incomingCost   / prev.costMillicents : 1;

  return (
    countDelta  > MATERIAL_DELTA_THRESHOLD ||
    tokensDelta > MATERIAL_DELTA_THRESHOLD ||
    costDelta   > MATERIAL_DELTA_THRESHOLD
  );
}

// ---------------------------------------------------------------------------
// Legacy: keep the /api/dashboard/subscribe (FleetRealtimeEvent) path working
// for any components that haven't migrated to the new DOM events yet.
// ---------------------------------------------------------------------------

function isMaterialChangeFromFleet(
  prev: EventSnapshot,
  incoming: FleetRealtimeEvent[],
): boolean {
  if (incoming.length === 0) return false;

  const incomingCount  = incoming.length;
  const incomingTokens = incoming.reduce(
    (sum, e) => sum + (e.tokens_input ?? 0) + (e.tokens_output ?? 0),
    0,
  );
  const incomingCost = incoming.reduce(
    (sum, e) => sum + (e.cost_millicents ?? 0),
    0,
  );

  if (prev.count === 0 && prev.tokens === 0 && prev.costMillicents === 0) {
    return incomingCount > 0 || incomingTokens > 0 || incomingCost > 0;
  }

  const countDelta  = prev.count          > 0 ? incomingCount  / prev.count          : 1;
  const tokensDelta = prev.tokens         > 0 ? incomingTokens / prev.tokens         : 1;
  const costDelta   = prev.costMillicents > 0 ? incomingCost   / prev.costMillicents : 1;

  return (
    countDelta  > MATERIAL_DELTA_THRESHOLD ||
    tokensDelta > MATERIAL_DELTA_THRESHOLD ||
    costDelta   > MATERIAL_DELTA_THRESHOLD
  );
}

export function DashboardSSE({ asUserId }: Props) {
  const router = useRouter();

  // ── Snapshot for /api/app/live activity events ────────────────────────────
  const snapshotRef = useRef<EventSnapshot>({ count: 0, tokens: 0, costMillicents: 0 });
  const refreshPendingRef = useRef(false);

  // Anomaly dedup: event_ids seen in this SSE session.
  const seenAnomalyIdsRef = useRef<Set<string>>(new Set());

  // ── Snapshot for legacy /api/dashboard/subscribe ──────────────────────────
  const legacySnapshotRef = useRef<EventSnapshot>({ count: 0, tokens: 0, costMillicents: 0 });
  const legacyRefreshPendingRef = useRef(false);

  // Rolling anomaly context (carried across legacy batches for client-side detection).
  const anomalyContextRef = useRef<AnomalyContext>({
    rollingDailyCosts: [],
    recentEventTokens: [],
    recentEvents: [],
    ownerCosts: {},
  });

  // ── /api/app/live SSE connection ──────────────────────────────────────────
  useEffect(() => {
    const url = asUserId
      ? `/api/app/live?as=${encodeURIComponent(asUserId)}`
      : "/api/app/live";

    const es = new EventSource(url);

    // "activity" named events
    es.addEventListener("activity", (event: MessageEvent<string>) => {
      let payload: LiveActivityEvent;
      try {
        payload = JSON.parse(event.data) as LiveActivityEvent;
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      const snap = snapshotRef.current;
      const batch = [payload];

      if (isMaterialChange(snap, batch)) {
        snapshotRef.current = {
          count:          snap.count + 1,
          tokens:         snap.tokens + (payload.tokens_total ?? 0),
          costMillicents: snap.costMillicents + (payload.cost_millicents ?? 0),
        };

        if (!refreshPendingRef.current) {
          refreshPendingRef.current = true;
          queueMicrotask(() => {
            refreshPendingRef.current = false;
            router.refresh();
          });
        }
      }

      // Dispatch pulse:activity DOM event so tab components can react immediately.
      window.dispatchEvent(
        new CustomEvent("pulse:activity", { detail: { event: payload } }),
      );
    });

    // "anomaly" named events
    es.addEventListener("anomaly", (event: MessageEvent<string>) => {
      let payload: LiveAnomalyEvent;
      try {
        payload = JSON.parse(event.data) as LiveAnomalyEvent;
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      // Client-side dedup by event_id (server also dedupes, but belt-and-suspenders).
      if (seenAnomalyIdsRef.current.has(payload.event_id)) return;
      seenAnomalyIdsRef.current.add(payload.event_id);

      // Dispatch pulse:anomaly DOM event.
      window.dispatchEvent(
        new CustomEvent("pulse:anomaly", {
          detail: { anomalies: [payload.anomaly] },
        }),
      );
    });

    // "heartbeat" named events — no-op; connection kept alive by EventSource.
    es.addEventListener("heartbeat", () => {
      // Intentionally no-op. EventSource handles keep-alive automatically.
    });

    es.onerror = () => {
      // EventSource auto-reconnects on error (browser spec). No action needed.
    };

    return () => {
      es.close();
    };
  }, [asUserId, router]);

  // ── Legacy /api/dashboard/subscribe SSE connection ────────────────────────
  useEffect(() => {
    const url = asUserId
      ? `/api/dashboard/subscribe?as=${encodeURIComponent(asUserId)}`
      : "/api/dashboard/subscribe";

    const es = new EventSource(url);

    es.onmessage = (event: MessageEvent<string>) => {
      let incoming: FleetRealtimeEvent[];
      try {
        incoming = JSON.parse(event.data) as FleetRealtimeEvent[];
      } catch {
        return;
      }
      if (!Array.isArray(incoming) || incoming.length === 0) return;

      const snap = legacySnapshotRef.current;

      if (isMaterialChangeFromFleet(snap, incoming)) {
        legacySnapshotRef.current = {
          count:          snap.count + incoming.length,
          tokens:         snap.tokens + incoming.reduce((s, e) => s + (e.tokens_input ?? 0) + (e.tokens_output ?? 0), 0),
          costMillicents: snap.costMillicents + incoming.reduce((s, e) => s + (e.cost_millicents ?? 0), 0),
        };

        if (!legacyRefreshPendingRef.current) {
          legacyRefreshPendingRef.current = true;
          queueMicrotask(() => {
            legacyRefreshPendingRef.current = false;
            router.refresh();
          });
        }
      }

      // Client-side anomaly detection on legacy events.
      const ctx = anomalyContextRef.current;
      const anomalies = deriveAnomalies(incoming, ctx);

      const newTokens = incoming.map((e) => (e.tokens_input ?? 0) + (e.tokens_output ?? 0));
      const updatedRecentTokens = [...(ctx.recentEventTokens ?? []), ...newTokens].slice(-100);
      const updatedRecentEvents = [...(ctx.recentEvents ?? []), ...incoming].slice(-100);

      const updatedOwnerCosts = { ...(ctx.ownerCosts ?? {}) };
      for (const e of incoming) {
        const owner = e.fleet_owner ?? "__unknown__";
        updatedOwnerCosts[owner] = (updatedOwnerCosts[owner] ?? 0) + (e.cost_millicents ?? 0);
      }

      const batchCost = incoming.reduce((s, e) => s + (e.cost_millicents ?? 0), 0);
      const updatedDailyCosts = [...(ctx.rollingDailyCosts ?? []), batchCost].slice(-7);

      anomalyContextRef.current = {
        rollingDailyCosts: updatedDailyCosts,
        recentEventTokens: updatedRecentTokens,
        recentEvents: updatedRecentEvents,
        ownerCosts: updatedOwnerCosts,
      };

      if (anomalies.length > 0) {
        window.dispatchEvent(
          new CustomEvent("pulse:anomaly", { detail: { anomalies } }),
        );
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on error — no action needed.
    };

    return () => {
      es.close();
    };
  }, [asUserId, router]);

  // Render nothing — pure side-effect component.
  return null;
}
