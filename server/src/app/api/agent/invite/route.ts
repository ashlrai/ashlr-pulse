/**
 * POST /api/agent/invite — agent-facing one-shot invite creation.
 *
 * Mirrors /api/invite/create but uses PAT bearer auth (same pattern as
 * /api/agent/heartbeat). This unblocks `pulse-agent invite <email>`,
 * which the docs (AGENTS.md) advertise but couldn't be implemented
 * against /api/invite/create — that route is cookie-session-only by
 * design ("we want the human user intent, not an agent's").
 *
 * The PAT was already minted via browser-mediated approval, so this
 * endpoint *is* still proof of human intent; it just runs at the TTY.
 *
 * Body (all optional):
 *   {
 *     email?: string,                         // for label/display only
 *     label?: string,                         // free-text override
 *     suggested_scope_type?: 'all' | 'project' | 'repo_pattern',
 *     suggested_scope_value?: string,
 *     suggested_granularity?: 'realtime' | 'daily' | 'weekly' | 'monthly',
 *     suggested_fields?: string[],
 *   }
 *
 * Returns: { token, url, expires_at, label }
 *
 * Plan gate: member cap (same as /api/invite/create).
 * Privacy floor: suggested_fields is whitelist-validated.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPat } from "@/lib/pat";
import { createInvite } from "@/lib/invite-db";
import { validateFields } from "@/lib/peer-share-guard";
import { primaryOrgForUser, countMembers, countPendingInvites } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { log, requestId } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email().max(254).optional(),
  label: z.string().min(1).max(120).optional(),
  suggested_scope_type: z.enum(["all", "project", "repo_pattern"]).optional(),
  suggested_scope_value: z.string().max(200).nullable().optional(),
  suggested_granularity: z.enum(["realtime", "daily", "weekly", "monthly"]).optional(),
  suggested_fields: z.array(z.string()).max(32).optional(),
});

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
  const userId = await verifyPat(token);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "x-request-id": rid } },
    );
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400, headers: { "x-request-id": rid } },
    );
  }

  // Member-cap gate — count current members + pending invites against
  // the org's plan limit (matches /api/invite/create logic).
  const org = await primaryOrgForUser(userId);
  if (org) {
    const limits = limitsFor(org);
    if (Number.isFinite(limits.max_members)) {
      const [members, pending] = await Promise.all([
        countMembers(org.id),
        countPendingInvites(userId),
      ]);
      if (members + pending >= limits.max_members) {
        return NextResponse.json(
          {
            error: `Free tier capped at ${limits.max_members} member. Upgrade to Pro at /billing.`,
          },
          { status: 402, headers: { "x-request-id": rid } },
        );
      }
    }
  }

  let suggestedFields: string[] | null = null;
  if (parsed.suggested_fields && parsed.suggested_fields.length > 0) {
    const guard = validateFields(parsed.suggested_fields);
    if (!guard.ok) {
      return NextResponse.json(
        { error: guard.error },
        { status: guard.status, headers: { "x-request-id": rid } },
      );
    }
    suggestedFields = guard.fields;
  }

  // Synthesize a label from email if neither label nor explicit hint is given.
  const label =
    parsed.label ??
    (parsed.email ? `for ${parsed.email}` : null);

  const invite = await createInvite({
    owner_id: userId,
    label,
    suggested_scope_type: parsed.suggested_scope_type ?? null,
    suggested_scope_value: parsed.suggested_scope_value ?? null,
    suggested_granularity: parsed.suggested_granularity ?? null,
    suggested_fields: suggestedFields,
  });

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const url = `${origin}/accept-invite/${invite.token}`;

  log.info({ msg: "agent invite created", user_id: userId, request_id: rid });

  return NextResponse.json(
    {
      token: invite.token,
      url,
      expires_at: invite.expires_at,
      label: invite.label,
    },
    { status: 201, headers: { "x-request-id": rid } },
  );
}
