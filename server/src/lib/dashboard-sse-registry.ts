/**
 * dashboard-sse-registry.ts — in-process SSE subscriber registry.
 *
 * Holds the live set of ReadableStream controllers for /api/dashboard/subscribe
 * connections. Extracted from the route file so it can be imported by both
 * the route handler (to register/unregister controllers) and by
 * fleet-realtime.ts (to fan-out events) without violating Next.js's
 * requirement that route files export only HTTP handler functions.
 *
 * Single-node deploy: in-process memory is sufficient. For multi-node,
 * replace notifySSESubscribers with a Redis pub/sub call — the interface
 * (SseController, register, notifySSESubscribers) stays the same.
 */

import type { FleetRealtimeEvent } from "./fleet-realtime";

// ---------------------------------------------------------------------------
// SseController — per-connection abstraction
// ---------------------------------------------------------------------------

export interface SseController {
  /** Enqueue a batch of events. Returns false if the stream is already closed. */
  send(events: FleetRealtimeEvent[]): boolean;
  /** Close the stream (server-side teardown). */
  close(): void;
}

// ---------------------------------------------------------------------------
// In-process registry
// ---------------------------------------------------------------------------

// Module-level — survives Next.js route-handler invocations within one process.
const registry = new Map<string, Set<SseController>>();

/**
 * Register a controller under userId.
 * Returns an unregister function — call it on stream close / cancel.
 */
export function register(userId: string, ctrl: SseController): () => void {
  let set = registry.get(userId);
  if (!set) {
    set = new Set();
    registry.set(userId, set);
  }
  set.add(ctrl);
  return () => {
    set!.delete(ctrl);
    if (set!.size === 0) registry.delete(userId);
  };
}

/**
 * Fan-out a batch of privacy-safe FleetRealtimeEvents to all SSE subscribers
 * for userId. Called by pushFleetEvents() in fleet-realtime.ts.
 *
 * Dead controllers (send() → false) are pruned on the next notification.
 * Returns the count of controllers that successfully received the batch.
 */
export function notifySSESubscribers(
  userId: string,
  events: FleetRealtimeEvent[],
): number {
  const set = registry.get(userId);
  if (!set || set.size === 0) return 0;

  let sent = 0;
  const dead: SseController[] = [];

  for (const ctrl of set) {
    const ok = ctrl.send(events);
    if (!ok) dead.push(ctrl);
    else sent++;
  }

  for (const ctrl of dead) {
    set.delete(ctrl);
    if (set.size === 0) registry.delete(userId);
  }

  return sent;
}

/** Subscriber count for a userId — used in tests. */
export function subscriberCount(userId: string): number {
  return registry.get(userId)?.size ?? 0;
}

/** Clear all subscribers — used in tests. */
export function clearRegistry(): void {
  registry.clear();
}
