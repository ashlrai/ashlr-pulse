/**
 * POST /api/ask — Ask Pulse endpoint.
 *
 * Body: { question: string }
 * Auth: cookie (current user)
 *
 * Returns: { query, rows, chart, summary } — see lib/ask-pulse.ts
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { parseQuestion, runQuery } from "@/lib/ask-pulse";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  question: z.string().min(2).max(400),
});

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
