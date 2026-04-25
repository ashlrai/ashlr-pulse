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
import { currentUser } from "@/lib/current-user";
import { validateFields } from "@/lib/peer-share-guard";
import {
  createPeerShare,
  findUserByEmail,
  listGrantsOwnedBy,
  listGrantsForViewer,
  type CreatePeerShareInput,
} from "@/lib/peer-share-db";

export const runtime = "nodejs";

interface CreateBody {
  viewer_email?: unknown;
  scope_type?: unknown;
  scope_value?: unknown;
  granularity?: unknown;
  fields?: unknown;
}

const SCOPE_TYPES = new Set(["all", "project", "repo_pattern"]);
const GRANULARITIES = new Set(["realtime", "daily", "weekly", "monthly"]);

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

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Field whitelist enforcement — never bypassed.
  const guard = validateFields(body.fields);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const scope_type = String(body.scope_type ?? "");
  if (!SCOPE_TYPES.has(scope_type)) {
    return NextResponse.json({ error: "scope_type must be all|project|repo_pattern" }, { status: 400 });
  }

  const granularity = String(body.granularity ?? "");
  if (!GRANULARITIES.has(granularity)) {
    return NextResponse.json({ error: "granularity must be realtime|daily|weekly|monthly" }, { status: 400 });
  }

  const viewerEmail = String(body.viewer_email ?? "").trim();
  if (!viewerEmail) {
    return NextResponse.json({ error: "viewer_email is required" }, { status: 400 });
  }
  const viewer = await findUserByEmail(viewerEmail);
  if (!viewer) {
    return NextResponse.json(
      { error: `no user with email ${viewerEmail} — they must sign in to Pulse first` },
      { status: 404 },
    );
  }
  if (viewer.id === me.id) {
    return NextResponse.json({ error: "cannot share with yourself" }, { status: 400 });
  }

  const scopeValue = body.scope_value ? String(body.scope_value) : null;
  if (scope_type !== "all" && !scopeValue) {
    return NextResponse.json(
      { error: "scope_value is required for scope_type=" + scope_type },
      { status: 400 },
    );
  }

  const input: CreatePeerShareInput = {
    owner_id: me.id,
    viewer_id: viewer.id,
    scope_type: scope_type as CreatePeerShareInput["scope_type"],
    scope_value: scope_type === "all" ? null : scopeValue,
    granularity: granularity as CreatePeerShareInput["granularity"],
    fields: guard.fields,
  };

  try {
    const row = await createPeerShare(input);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Unique-violation on (owner, viewer, scope_type, scope_value) — i.e.
    // "you already shared this with them". Treat as 409 conflict.
    if (/duplicate key|unique/i.test(message)) {
      return NextResponse.json(
        { error: "you already have an active grant with this scope for this viewer" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "create failed", detail: message }, { status: 500 });
  }
}
