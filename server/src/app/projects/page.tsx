/**
 * /projects — list + create projects, manage repos per project.
 *
 * First project create auto-creates a default org (slug = email local part).
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser, ensureDefaultOrg } from "@/lib/current-user";
import {
  listProjects,
  createProject,
  createProjectWithRepos,
  addProjectRepo,
  removeProjectRepo,
  listUnassignedRepos,
  clusterByPrefix,
} from "@/lib/project-db";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { palette, radius, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

const VALID_KINDS = ["saas", "client", "internal", "experiment"] as const;
type ProjectKind = typeof VALID_KINDS[number];

async function createProjectAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "internal") as ProjectKind;
  if (!name) redirect("/projects?error=name+required");
  if (!VALID_KINDS.includes(kind)) redirect("/projects?error=invalid+kind");

  const orgId = await ensureDefaultOrg(me.id, me.email);
  try {
    await createProject({ org_id: orgId, name, kind });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    redirect(`/projects?error=${encodeURIComponent(m)}`);
  }
  revalidatePath("/projects");
  redirect("/projects?ok=created");
}

async function addRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const projectId = String(formData.get("project_id") ?? "");
  const repoName = String(formData.get("repo_name") ?? "").trim();
  if (!projectId || !repoName) return;
  await addProjectRepo(projectId, repoName, me.id);
  revalidatePath("/projects");
}

async function removeRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const projectId = String(formData.get("project_id") ?? "");
  const repoName = String(formData.get("repo_name") ?? "");
  if (!projectId || !repoName) return;
  await removeProjectRepo(projectId, repoName, me.id);
  revalidatePath("/projects");
}

async function assignRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const projectId = String(formData.get("project_id") ?? "");
  const repoName = String(formData.get("repo_name") ?? "");
  if (!projectId || !repoName) return;
  await addProjectRepo(projectId, repoName, me.id);
  revalidatePath("/projects");
}

async function createFromPrefixAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "internal") as ProjectKind;
  const repos = formData.getAll("repos").map(String).filter(Boolean);
  if (!name || repos.length === 0) redirect("/projects?error=missing+fields");
  if (!VALID_KINDS.includes(kind)) redirect("/projects?error=invalid+kind");

  const orgId = await ensureDefaultOrg(me.id, me.email);
  try {
    await createProjectWithRepos({ org_id: orgId, name, kind }, repos);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    redirect(`/projects?error=${encodeURIComponent(m)}`);
  }
  revalidatePath("/projects");
  redirect(`/projects?ok=created+${repos.length}+repos`);
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const projects = await listProjects(me.id);
  const unassigned = await listUnassignedRepos(me.id);
  const clusters = clusterByPrefix(unassigned);
  const { ok, error } = await searchParams;

  return (
    <DashboardShell maxWidth={960}>
      <Header me={me} active="projects" />
      <h1 style={pageTitle}>projects</h1>
      <p style={pageSub}>
        group repos into saas / client / internal / experiment buckets so the dashboard rolls up by line of work.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {ok && <Banner variant="success">{ok.replace(/\+/g, " ")}</Banner>}
        {error && <Banner variant="danger">{error.replace(/\+/g, " ")}</Banner>}

        <form action={createProjectAction}>
          <Card>
            <CardHeader title="new project" />
            <div style={{ display: "flex", gap: space.x3, alignItems: "flex-end" }}>
              <div style={{ flex: 2 }}>
                <Field label="name">
                  <Input name="name" type="text" required placeholder="my-saas" />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="kind">
                  <Select name="kind" defaultValue="internal">
                    {VALID_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </Select>
                </Field>
              </div>
              <Button type="submit" variant="primary" style={{ marginBottom: space.x4 }}>create</Button>
            </div>
          </Card>
        </form>

        {clusters.length > 0 && (
          <Card>
            <CardHeader
              title="suggested projects"
              hint="groups of unassigned repos that share a common prefix — one click to bulk-assign"
            />
            <div style={{ display: "flex", flexDirection: "column", gap: space.x2 }}>
              {clusters.map((c) => (
                <form
                  key={c.prefix}
                  action={createFromPrefixAction}
                  style={{
                    display: "flex", gap: space.x2, alignItems: "center",
                    padding: `${space.x2}px ${space.x3}px`,
                    border: `1px dashed ${palette.border}`,
                    borderRadius: radius.md,
                    background: palette.bgRaised,
                  }}
                >
                  <code style={prefixChip}>{c.prefix}-*</code>
                  <span style={{ fontSize: 12, color: palette.textDim, flex: 1 }}>
                    {c.repos.length} repos: {c.repos.slice(0, 3).join(", ")}
                    {c.repos.length > 3 ? `, +${c.repos.length - 3} more` : ""}
                  </span>
                  {c.repos.map((r) => <input key={r} type="hidden" name="repos" value={r} />)}
                  <input type="hidden" name="name" value={c.prefix} />
                  <Select
                    name="kind"
                    defaultValue={c.prefix.startsWith("client") ? "client" : "saas"}
                    style={{ width: 120 }}
                  >
                    {VALID_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </Select>
                  <Button type="submit" variant="primary" size="sm">
                    create + add {c.repos.length}
                  </Button>
                </form>
              ))}
            </div>
          </Card>
        )}

        {unassigned.length > 0 && projects.length > 0 && (
          <Card>
            <CardHeader
              title={`unassigned repos · ${unassigned.length}`}
              hint="repos we've seen activity for that aren't in any project — assign individually"
            />
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {unassigned.map((r) => (
                <li
                  key={r}
                  style={{
                    display: "flex", gap: space.x2, alignItems: "center",
                    padding: "6px 0", fontSize: 12,
                    borderBottom: `1px dashed ${palette.border}`,
                  }}
                >
                  <code style={{ flex: 1, color: palette.text }}>{r}</code>
                  <form action={assignRepoAction} style={{ display: "flex", gap: 6 }}>
                    <input type="hidden" name="repo_name" value={r} />
                    <Select name="project_id" required style={{ width: 200, padding: "4px 28px 4px 8px", fontSize: 11 }}>
                      <option value="">— assign to —</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                    <Button type="submit" variant="secondary" size="sm">assign</Button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title={`your projects · ${projects.length}`} />
          {projects.length === 0 ? (
            <p style={{ color: palette.textMute, fontSize: 13, margin: 0 }}>
              no projects yet — create one above or accept a suggestion.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: space.x3 }}>
              {projects.map((p) => (
                <div
                  key={p.id}
                  style={{
                    padding: `${space.x3}px ${space.x4}px`,
                    background: palette.bgRaised,
                    border: `1px solid ${palette.border}`,
                    borderRadius: radius.md,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 600, color: palette.text }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                      {p.kind}
                    </span>
                  </div>
                  <p style={{ margin: "4px 0 8px", fontSize: 11, color: palette.textMute }}>
                    {p.id}
                  </p>

                  {p.repos.length > 0 && (
                    <ul style={{ margin: "0 0 8px", padding: 0, listStyle: "none" }}>
                      {p.repos.map((r) => (
                        <li
                          key={r}
                          style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}
                        >
                          <code style={{ color: palette.green }}>{r}</code>
                          <form action={removeRepoAction} style={{ display: "inline" }}>
                            <input type="hidden" name="project_id" value={p.id} />
                            <input type="hidden" name="repo_name" value={r} />
                            <Button type="submit" variant="danger" size="sm">remove</Button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form action={addRepoAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="hidden" name="project_id" value={p.id} />
                    <Input name="repo_name" type="text" placeholder="owner/repo" style={{ width: 240 }} />
                    <Button type="submit" variant="secondary" size="sm">add repo</Button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </DashboardShell>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const prefixChip: React.CSSProperties = {
  background: palette.bgSurface, color: palette.green,
  padding: "3px 8px", borderRadius: radius.sm,
  fontSize: 11, letterSpacing: "0.3px",
};
