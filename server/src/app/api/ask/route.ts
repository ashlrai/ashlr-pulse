/**
 * POST /api/ask — Ask Pulse endpoint.
 *
 * Body: { question: string }
 * Auth: cookie (current user)
 *
 * Returns: { query, rows, chart, summary } — see lib/ask-pulse.ts
 *
 * Plan gate: ai_features=true required (Pro+). Free tier returns 402.
 * Rate limit: per-user token bucket — 30 req/hr default to cap Claude
 *   spend on a hammered account. Override via PULSE_ASK_RATE_LIMIT
 *   ("<capacity>:<refillPerSec>", e.g. "30:0.00833").
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { parseQuestion, runQuery } from "@/lib/ask-pulse";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { checkBucket } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  question: z.string().min(2).max(400),
});

function askRateLimit(): { capacity: number; refillPerSec: number } {
  const raw = process.env.PULSE_ASK_RATE_LIMIT ?? "30:0.00833";
  const [capStr, refillStr] = raw.split(":");
  const capacity = Number(capStr);
  const refillPerSec = Number(refillStr);
  if (!Number.isFinite(capacity) || capacity <= 0) return { capacity: 30, refillPerSec: 0.00833 };
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) return { capacity: 30, refillPerSec: 0.00833 };
  return { capacity, refillPerSec };
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Plan gate — Ask Pulse calls Claude on every request. Free orgs are
  // gated; trialing/active Pro+ pass through.
  const org = await primaryOrgForUser(me.id);
  if (org && !limitsFor(org).ai_features) {
    return NextResponse.json(
      { error: "Ask Pulse is a Pro feature. Upgrade to Pro at /billing." },
      { status: 402 },
    );
  }

  // Per-user rate limit — caps spend even on Pro.
  const { capacity, refillPerSec } = askRateLimit();
  const rl = checkBucket(`ask:${me.id}`, capacity, refillPerSec);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded — try again shortly" },
      {
        status: 429,
        headers: { "retry-after": String(rl.retryAfterSec) },
      },
    );
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const query = await parseQuestion(parsed.question);
  if (!query) {
    return NextResponse.json(
      { error: "could not parse question — try rephrasing or check that ANTHROPIC_API_KEY is set" },
      { status: 400 },
    );
  }

  const result = await runQuery(me.id, query);
  return NextResponse.json(result);
}
