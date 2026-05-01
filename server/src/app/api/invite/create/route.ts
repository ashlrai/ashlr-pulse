/**
 * POST /api/invite/create — create a one-shot invite link.
 *
 * Auth: Supabase session (currentUser). Inviting cofounders is a
 * dashboard action, not an OTLP-PAT one — we want the human user
 * intent, not an agent's.
 *
 * Body (all optional):
 *   {
 *     label?: string,                     // free-text, e.g. "for kara"
 *     suggested_scope_type?: 'all' | 'project' | 'repo_pattern',
 *     suggested_scope_value?: string,
 *     suggested_granularity?: 'realtime' | 'daily' | 'weekly' | 'monthly',
 *     suggested_fields?: string[],
 *   }
 *
 * Returns: { token, url, expires_at }
 *
 * The peer_share fields whitelist (lib/peer-share-guard) is enforced —
 * if `suggested_fields` includes anything forbidden the request 4xx's.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { createInvite } from "@/lib/invite-db";
import { validateFields } from "@/lib/peer-share-guard";
import { primaryOrgForUser, countMembers, countPendingInvites } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";

export const runtime = "nodejs";

const Body = z.object({
  label: z.string().min(1).max(120).optional(),
  suggested_scope_type: z.enum(["all", "project", "repo_pattern"]).optional(),
  suggested_scope_value: z.string().max(200).nullable().optional(),
  suggested_granularity: z.enum(["realtime", "daily", "weekly", "monthly"]).optional(),
  suggested_fields: z.array(z.string()).max(32).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  // Gate 1: member cap. Count current members + pending invites against
  // the org's plan limit. We count pending invites so that a free-tier
  // user can't queue up multiple invites and accept them all at once.
  const org = await primaryOrgForUser(me.id);
  if (org) {
    const limits = limitsFor(org);
    if (Number.isFinite(limits.max_members)) {
      const [members, pending] = await Promise.all([
        countMembers(org.id),
        countPendingInvites(me.id),
      ]);
      if (members + pending >= limits.max_members) {
        return NextResponse.json(
          {
            error: `Free tier capped at ${limits.max_members} member. Upgrade to Pro at /billing.`,
          },
          { status: 402 },
        );
      }
    }
  }

  // If suggested_fields is provided, validate against the privacy-floor
  // whitelist. Lets the inviter say "share repo + tokens with my cofounder
  // by default" without us also accepting a request that asks for prompts.
  let suggestedFields: string[] | null = null;
  if (parsed.suggested_fields && parsed.suggested_fields.length > 0) {
    const guard = validateFields(parsed.suggested_fields);
    if (!guard.ok) {
      return NextResponse.json({ error: guard.error }, { status: guard.status });
    }
    suggestedFields = guard.fields;
  }

  const invite = await createInvite({
    owner_id: me.id,
    label: parsed.label ?? null,
    suggested_scope_type: parsed.suggested_scope_type ?? null,
    suggested_scope_value: parsed.suggested_scope_value ?? null,
    suggested_granularity: parsed.suggested_granularity ?? null,
    suggested_fields: suggestedFields,
  });

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({
    token: invite.token,
    url: `${origin}/accept-invite/${invite.token}`,
    expires_at: invite.expires_at,
    label: invite.label,
  });
}
