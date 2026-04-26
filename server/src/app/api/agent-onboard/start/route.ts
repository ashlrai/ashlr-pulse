/**
 * POST /api/agent-onboard/start — agent kicks off a new onboarding flow.
 *
 * Public (no auth) — the secret of this exchange is the *session* the
 * approving user has, not the code. The agent supplies an optional
 * `agent_label` (e.g. hostname) so the resulting PAT has a meaningful
 * name in the user's PAT list.
 *
 * Returns the code + the URL the user must visit. Agent prints the URL,
 * starts polling /api/agent-onboard/poll until the row is approved.
 *
 * Rate limit: 30/min per IP via the existing token-bucket so a script
 * can't spray codes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generateCode, getCode, startCode } from "@/lib/agent-onboard-db";
import { checkBucket } from "@/lib/rate-limit";
import { log, requestId } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({
  agent_label: z.string().min(1).max(80).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const rid = requestId(req);

  // Rate limit by IP — this is unauthenticated, so a key derived from
  // the request is the best we have. x-forwarded-for is best-effort.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  const rl = checkBucket(`onboard-start:${ip}`, 30, 0.5);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "x-request-id": rid, "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // Generate-and-retry on the (vanishingly unlikely) collision case.
  let code = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    if (!(await getCode(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return NextResponse.json(
      { error: "could not allocate code" },
      { status: 503, headers: { "x-request-id": rid } },
    );
  }

  const row = await startCode(code, parsed.agent_label ?? null);
  log.info({ msg: "onboard: code issued", code, agent_label: parsed.agent_label, request_id: rid });

  // Construct the approval URL using the request origin. The agent
  // printed `--url <server>` so this matches what the user expects.
  const origin = new URL(req.url).origin;
  return NextResponse.json({
    code,
    url: `${origin}/agent-onboard?code=${code}`,
    expires_at: row.expires_at,
    poll_interval_sec: 2,
  });
}
