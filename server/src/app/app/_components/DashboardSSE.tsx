"use client";

/**
 * DashboardSSE.tsx — client-side SSE subscriber for the /app dashboard.
 *
 * Mounts a single EventSource to GET /api/dashboard/subscribe (optionally
 * with ?as=<userId> for peer-share views). As FleetRealtimeEvent batches
 * arrive, the component:
 *
 *   1. Merges the incoming events into a local ref-tracked snapshot.
 *   2. Computes whether the new batch constitutes a "material" change:
 *        - event count differs by > 5 % from the current snapshot, OR
 *        - token total differs by > 5 %, OR
 *        - cost_millicents total differs by > 5 %.
 *   3. On a material change, fires router.refresh() (Next.js App Router)
 *      which triggers a server revalidation of the page without a full
 *      navigation. Equivalent to `revalidatePath` but triggered from
 *      the client side.
 *
 * The component renders nothing — it is a pure side-effect hook component
 * dropped into the server page layout.
 *
 * Polling fallback
 * ────────────────
 * The existing polling behaviour (if any) on individual tab components is
 * untouched. The SSE path is purely additive — a missed or dropped
 * broadcast just means the next poll catches up.
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

interface Props {
  /** When set, subscribe to this user's events via peer-share scope. */
  asUserId?: string;
}

/** Minimum fractional change in any aggregate metric to trigger a refresh. */
const MATERIAL_DELTA_THRESHOLD = 0.05; // 5 %

interface EventSnapshot {
  count: number;
  tokens: number;      // tokens_input + tokens_output
  costMillicents: number;
}

function isMaterialChange(prev: EventSnapshot, incoming: FleetRealtimeEvent[]): boolean {
  if (incoming.length === 0) return false;

  const incomingCount = incoming.length;
  const incomingTokens = incoming.reduce(
    (sum, e) => sum + (e.tokens_input ?? 0) + (e.tokens_output ?? 0),
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

  const countDelta  = prev.count         > 0 ? incomingCount  / prev.count         : 1;
  const tokensDelta = prev.tokens        > 0 ? incomingTokens / prev.tokens        : 1;
  const costDelta   = prev.costMillicents > 0 ? incomingCost   / prev.costMillicents : 1;

  return (
    countDelta  > MATERIAL_DELTA_THRESHOLD ||
    tokensDelta > MATERIAL_DELTA_THRESHOLD ||
    costDelta   > MATERIAL_DELTA_THRESHOLD
  );
}

export function DashboardSSE({ asUserId }: Props) {
  const router = useRouter();
  const snapshotRef = useRef<EventSnapshot>({ count: 0, tokens: 0, costMillicents: 0 });
  // Debounce: only refresh once per DEBOUNCE_MS even if multiple batches arrive.
  const refreshPendingRef = useRef(false);

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

      const snap = snapshotRef.current;

      if (isMaterialChange(snap, incoming)) {
        // Update snapshot with the incoming totals.
        snapshotRef.current = {
          count:          snap.count + incoming.length,
          tokens:         snap.tokens + incoming.reduce((s, e) => s + (e.tokens_input ?? 0) + (e.tokens_output ?? 0), 0),
          costMillicents: snap.costMillicents + incoming.reduce((s, e) => s + (e.cost_millicents ?? 0), 0),
        };

        // Debounce concurrent batches into a single refresh tick.
        if (!refreshPendingRef.current) {
          refreshPendingRef.current = true;
          // Micro-task defer so multiple same-tick batches are coalesced.
          queueMicrotask(() => {
            refreshPendingRef.current = false;
            router.refresh();
          });
        }
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect on error (browser spec behaviour).
      // We do nothing here — the connection recovers on its own.
    };

    return () => {
      es.close();
    };
  }, [asUserId, router]);

  // Render nothing — pure side-effect component.
  return null;
}
