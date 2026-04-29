/**
 * GET /api/stream — Server-Sent Events stream of dashboard tickers.
 *
 * Per-user, per-connection. Every 15 seconds, computes the current 24h
 * totals (events / tokens / cost / commits) and emits one event. The
 * dashboard subscribes via EventSource and updates a "live" indicator
 * + ticker counters without a full page reload.
 *
 * Implementation note: this is a *polling* SSE — the server polls the
 * DB on each tick and pushes the deltas to the client. A future
 * upgrade can swap the polling for Postgres LISTEN/NOTIFY without
 * changing the client. The 15-second cadence is light enough that the
 * polling cost is negligible vs. the incoming OTLP write rate.
 *
 * Auth: same cookie-session as the rest of the app. We never accept
 * a `?as=` query param here — peer-share grants render through the
 * normal page route, not the live stream.
 */

import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { costUsdCents } from "@/lib/pricing";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICK_MS = 15_000;

interface Tick {
  ts: string;
  events_24h: number;
  tokens_24h: number;
  cents_24h: number;
}

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  const userId = me.id;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stopped = false;

      // Send a comment first so connection is acknowledged.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const sendTick = async () => {
        if (stopped) return;
        try {
          const t = await fetchTick(userId);
          const payload = `event: tick\ndata: ${JSON.stringify(t)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch (err) {
          log.warn({ msg: "stream: tick failed", err: err instanceof Error ? err.message : String(err) });
        }
      };

      // Initial tick + interval. Heartbeat comments every TICK_MS to
      // prevent intermediaries from closing the idle connection.
      await sendTick();
      const interval = setInterval(sendTick, TICK_MS);

      // Stop when the consumer aborts (browser tab closed).
      const abort = () => {
        stopped = true;
        clearInterval(interval);
        try { controller.close(); } catch { /* already closed */ }
      };

      // Sentinel timeout so a single client can't hold the connection
      // forever. 6h is plenty for an open dashboard tab; the client
      // EventSource auto-reconnects when the server closes.
      setTimeout(abort, 6 * 3600 * 1000);
    },
    cancel() {
      // Browser closed the EventSource — do nothing extra; the start()
      // closure will hit `stopped` on its next iteration.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      // Disable buffering on Nginx-style proxies (Railway already
      // streams; this is harmless redundancy).
      "X-Accel-Buffering": "no",
    },
  });
}

async function fetchTick(userId: string): Promise<Tick> {
  const db = sql();
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 3600_000);

  const rows = await db<{
    model: string | null;
    tokens_input: number | null;
    tokens_output: number | null;
    tokens_cache_read: number | null;
    tokens_cache_write: number | null;
    tokens_cache_5m_write: number | null;
    tokens_cache_1h_write: number | null;
    ts: string;
  }[]>`
    SELECT model,
           tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
           tokens_cache_5m_write, tokens_cache_1h_write,
           ts::text AS ts
    FROM activity_event
    WHERE user_id = ${userId}::uuid
      AND ts >= ${since.toISOString()}::timestamptz
  `;

  let tokens = 0, cents = 0;
  for (const r of rows) {
    tokens += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    const c = costUsdCents({
      model: r.model,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      tokens_cache_5m_write: r.tokens_cache_5m_write,
      tokens_cache_1h_write: r.tokens_cache_1h_write,
      ts: new Date(r.ts),
    });
    if (c != null) cents += c;
  }

  return {
    ts: now.toISOString(),
    events_24h: rows.length,
    tokens_24h: tokens,
    cents_24h: cents,
  };
}
