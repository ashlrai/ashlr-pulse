/**
 * GET /api/agent-onboard/poll?code=XXXXXXXX — agent polls for approval.
 *
 * Public (no auth). The code is the lookup key; presenting it doesn't
 * grant anything by itself — only an *approved* code yields a PAT, and
 * approval requires an authenticated browser session.
 *
 * Returns:
 *   200 { status: "pending" }                — keep polling
 *   200 { status: "approved", pat: "pulse_pat_..." }  — one-shot, row deleted
 *   404 { error: "not found" }               — expired, consumed, or never existed
 *   429                                       — rate limited (stop polling)
 *
 * The PAT is minted at consume time, so it never lives at rest in the
 * database — only in this HTTP response and in the agent's keyring.
 */

import { NextResponse } from "next/server";
import { consumeApprovedCode, getCode } from "@/lib/agent-onboard-db";
import { mintPat } from "@/lib/pat";
import { checkBucket } from "@/lib/rate-limit";
import { log, requestId } from "@/lib/logger";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const rid = requestId(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";

  if (!/^[A-Z2-9]{8}$/.test(code)) {
    return NextResponse.json(
      { error: "invalid code format" },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // Tight rate limit per-code: legitimate agent polls every 2s for ~5min
  // = 150 polls. 30/min = 0.5/s with burst 30 covers that comfortably
  // and rejects guessing.
  const rl = checkBucket(`onboard-poll:${code}`, 30, 0.5);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "x-request-id": rid, "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // Fast path: still pending? Tell the agent to keep polling.
  const row = await getCode(code);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "x-request-id": rid } },
    );
  }
  if (row.status === "pending") {
    return NextResponse.json(
      { status: "pending", expires_at: row.expires_at },
      { headers: { "x-request-id": rid } },
    );
  }

  // Approved: atomically consume the row, mint a fresh PAT for the user.
  const consumed = await consumeApprovedCode(code);
  if (!consumed) {
    // Lost race: a parallel poll consumed it first.
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "x-request-id": rid } },
    );
  }

  const label = consumed.agent_label ?? "unnamed";
  const patName = `agent-init: ${label} (${new Date().toISOString().slice(0, 10)})`;
  const minted = await mintPat(consumed.user_id, patName, ["ingest", "heartbeat"]);

  log.info({
    msg: "onboard: pat issued",
    code,
    pat_id: minted.id,
    user_id: consumed.user_id,
    agent_label: label,
    request_id: rid,
  });

  return NextResponse.json(
    { status: "approved", pat: minted.token, pat_id: minted.id },
    { headers: { "x-request-id": rid } },
  );
}
