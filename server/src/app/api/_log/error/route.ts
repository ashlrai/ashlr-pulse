/**
 * POST /api/_log/error — receive client-side error pings from error.tsx.
 *
 * Body: { digest: string } — Next.js error boundary digest (NOT the raw
 * error.message, which could leak stack info or prompt content).
 * We log it server-side via pino so the error appears in structured logs
 * without ever reaching the user's screen.
 */

import { NextResponse } from "next/server";
import { log, requestId } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const rid = requestId(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const digest = typeof body === "object" && body !== null && "digest" in body
    ? String((body as Record<string, unknown>).digest)
    : "unknown";

  log.error({ msg: "client error boundary triggered", digest, request_id: rid });
  return NextResponse.json({ ok: true }, { headers: { "x-request-id": rid } });
}
