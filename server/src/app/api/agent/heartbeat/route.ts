/**
 * POST /api/agent/heartbeat — agent liveness ping.
 *
 * Auth: same Bearer-PAT pattern as OTLP ingest. Verified via verifyPat;
 * we hash the token client-side identically to derive the row PK so
 * heartbeats from the same agent always upsert the same row.
 *
 * Body (optional): { agent_label?: string, agent_version?: string }
 *   - agent_label is e.g. "macbook-pro" so a multi-machine user can
 *     distinguish their agents in the dashboard
 *   - agent_version unblocks "agent is behind, upgrade" UX later
 *
 * Returns 204. Rate-limited per-PAT (1/min average, burst 10) — the
 * agent only needs to send ~1/min in the steady state.
 */

import { NextResponse } from "next/server";
import { verifyPat } from "@/lib/pat";
import { recordHeartbeat } from "@/lib/heartbeat";
import { checkBucket } from "@/lib/rate-limit";
import { log, requestId } from "@/lib/logger";

export const runtime = "nodejs";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(req: Request): Promise<Response> {
  const rid = requestId(req);
  const authz = req.headers.get("authorization");
  if (!authz?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }
  const token = authz.slice(7).trim();
  const userId = await verifyPat(token, "heartbeat");
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  // Per-PAT rate limit. Use the prefix as the bucket key (same idea as
  // the OTLP route — never use the full token as a map key).
  const bucketKey = `heartbeat:${token.slice(0, 26)}`;
  const rl = checkBucket(bucketKey, 10, 1 / 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      {
        status: 429,
        headers: {
          "x-request-id": rid,
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  let body: { agent_label?: string; agent_version?: string } = {};
  try {
    const text = await req.text();
    if (text.length > 0 && text.length < 1024) {
      body = JSON.parse(text);
    }
  } catch {
    // Empty / malformed body is fine — it's optional metadata.
  }

  const patHash = await sha256Hex(token);
  await recordHeartbeat({
    patHash,
    userId,
    agentLabel: typeof body.agent_label === "string" ? body.agent_label.slice(0, 80) : null,
    agentVersion: typeof body.agent_version === "string" ? body.agent_version.slice(0, 32) : null,
  });

  log.debug({ msg: "agent heartbeat", user_id: userId, request_id: rid });
  return new Response(null, { status: 204, headers: { "x-request-id": rid } });
}
