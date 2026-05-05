/**
 * /api/peer-share — list (GET) + create (POST) grants.
 *
 * Auth: cookie-session via currentUser(). PAT bearer is *not* accepted
 * here — PATs are ingest-only by design (see lib/pat.ts).
 *
 * The privacy hard-floor (no prompts/completions/raw_otel_span) is
 * enforced via validateFields() before any DB write.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { validateFields } from "@/lib/peer-share-guard";
import {
  createPeerShare,
  findUserByEmail,
  listGrantsOwnedBy,
  listGrantsForViewer,
  type CreatePeerShareInput,
} from "@/lib/peer-share-db";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor, PlanGateError } from "@/lib/plan-gate";

export const runtime = "nodejs";

// Task 8: Zod schema for POST body. The guard layer still runs after parse.
const CreateShareSchema = z.object({
  viewer_email: z.string().email("viewer_email must be a valid email"),
  scope_type: z.enum(["all", "project", "repo_pattern"]),
  scope_value: z.string().nullable().optional(),
  granularity: z.enum(["realtime", "daily", "weekly", "monthly"]),
  fields: z.array(z.string()),
});

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [owned, granted] = await Promise.all([
    listGrantsOwnedBy(me.id),
    listGrantsForViewer(me.id),
  ]);
  return NextResponse.json({ owned, granted });
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Zod parse — return flattened errors on failure.
  const parsed = CreateShareSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // Field whitelist enforcement — never bypassed (privacy hard-floor).
  const guard = validateFields(body.fields);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const viewer = await findUserByEmail(body.viewer_email);
  if (!viewer) {
    return NextResponse.json(
      { error: `no user with email ${body.viewer_email} — they must sign in to Pulse first` },
      { status: 404 },
    );
  }
  if (viewer.id === me.id) {
    return NextResponse.json({ error: "cannot share with yourself" }, { status: 400 });
  }

  const scopeValue = body.scope_value ?? null;
  if (body.scope_type !== "all" && !scopeValue) {
    return NextResponse.json(
      { error: "scope_value is required for scope_type=" + body.scope_type },
      { status: 400 },
    );
  }

  // Gate 4: peer_share_enabled. Mirrors the server-action pre-check in
  // share/page.tsx so the API surfaces a 402 instead of a generic 500
  // when createPeerShare throws PlanGateError.
  const ownerOrg = await primaryOrgForUser(me.id);
  if (ownerOrg && !limitsFor(ownerOrg).peer_share_enabled) {
    return NextResponse.json(
      { error: "Peer sharing is a Pro feature. Upgrade to Pro at /billing." },
      { status: 402 },
    );
  }

  const input: CreatePeerShareInput = {
    owner_id: me.id,
    viewer_id: viewer.id,
    scope_type: body.scope_type,
    scope_value: body.scope_type === "all" ? null : scopeValue,
    granularity: body.granularity,
    fields: guard.fields,
    ownerOrg: ownerOrg ?? undefined,
  };

  try {
    const row = await createPeerShare(input);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    if (err instanceof PlanGateError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    // Unique-violation on (owner, viewer, scope_type, scope_value).
    if (/duplicate key|unique/i.test(message)) {
      return NextResponse.json(
        { error: "you already have an active grant with this scope for this viewer" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "create failed", detail: message }, { status: 500 });
  }
}
