/**
 * /api/project — list (GET) + create (POST) projects.
 *
 * POST auto-creates a default org if the user has none yet.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { ensureDefaultOrg } from "@/lib/current-user";
import { listProjects, createProject } from "@/lib/project-db";
import { primaryOrgForUser } from "@/lib/org-db";
import { PlanGateError } from "@/lib/plan-gate";

export const runtime = "nodejs";

const VALID_KINDS = ["saas", "client", "internal", "experiment"] as const;
type ProjectKind = typeof VALID_KINDS[number];

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const projects = await listProjects(me.id);
  return NextResponse.json(projects);
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const kind = typeof b.kind === "string" ? b.kind.trim() : "internal";

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!VALID_KINDS.includes(kind as ProjectKind)) {
    return NextResponse.json({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` }, { status: 400 });
  }

  const [orgId, org] = await Promise.all([
    ensureDefaultOrg(me.id, me.email),
    primaryOrgForUser(me.id),
  ]);
  try {
    const project = await createProject(
      { org_id: orgId, name, kind: kind as ProjectKind },
      org ?? undefined,
    );
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof PlanGateError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique/i.test(message)) {
      return NextResponse.json({ error: "a project with that name already exists in your org" }, { status: 409 });
    }
    return NextResponse.json({ error: "create failed", detail: message }, { status: 500 });
  }
}
