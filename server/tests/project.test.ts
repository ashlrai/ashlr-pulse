/**
 * project.test.ts — round-trip integration tests for projects + repos.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser } from "../src/lib/current-user";
import { ensureDefaultOrg } from "../src/lib/current-user";
import { createProject, listProjects, addProjectRepo, removeProjectRepo } from "../src/lib/project-db";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("project round trip", () => {
  const testEmail = `pulse-project-test-${Date.now()}@local`;
  let userId: string;
  let orgId: string;

  beforeAll(async () => {
    const user = await ensureLocalUser(testEmail, null);
    userId = user.id;
    orgId = await ensureDefaultOrg(userId, testEmail);
  });

  afterAll(async () => {
    const db = sql();
    await db`DELETE FROM "user" WHERE email = ${testEmail}`;
  });

  test("ensureDefaultOrg is idempotent", async () => {
    const id2 = await ensureDefaultOrg(userId, testEmail);
    expect(id2).toBe(orgId);
  });

  test("create → list → add 2 repos → list → delete one", async () => {
    const project = await createProject({ org_id: orgId, name: "test-proj", kind: "internal" });
    expect(project.id).toBeTruthy();
    expect(project.repos).toHaveLength(0);

    // List includes the new project.
    const listed = await listProjects(userId);
    const found = listed.find((p) => p.id === project.id);
    expect(found).toBeTruthy();

    // Add two repos.
    const r1 = await addProjectRepo(project.id, "owner/repo-one", userId);
    const r2 = await addProjectRepo(project.id, "owner/repo-two", userId);
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    // List shows both repos.
    const after = await listProjects(userId);
    const p = after.find((x) => x.id === project.id)!;
    expect(p.repos).toContain("owner/repo-one");
    expect(p.repos).toContain("owner/repo-two");

    // Delete one.
    const del = await removeProjectRepo(project.id, "owner/repo-one", userId);
    expect(del).toBe(true);

    const final = await listProjects(userId);
    const pf = final.find((x) => x.id === project.id)!;
    expect(pf.repos).not.toContain("owner/repo-one");
    expect(pf.repos).toContain("owner/repo-two");

    // Non-owner cannot add/remove repos.
    const fakeUser = "00000000-0000-0000-0000-000000000000";
    expect(await addProjectRepo(project.id, "owner/repo-x", fakeUser)).toBe(false);
    expect(await removeProjectRepo(project.id, "owner/repo-two", fakeUser)).toBe(false);
  });
});
