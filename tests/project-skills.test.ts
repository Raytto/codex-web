import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { LEGACY_USER_ID } from "../server/db.js";
import { ensureTenant } from "../server/paths.js";
import { ensureTenantProjectLayout } from "../server/tenant-projects.js";
import { createProjectSkill, deleteProjectSkill, listProjectSkills, readProjectSkill, setProjectSkillEnabled, updateProjectSkill } from "../server/project-skills.js";
import { ensurePersonalMemoryLibrary, personalMemoryEnabled, readPersonalMemoryManagedFiles, writePersonalMemoryManagedFile } from "../server/personal-memory-files.js";

const skill = (name: string, body = "Do the project thing.") => `---\nname: ${name}\ndescription: Project-only instructions.\n---\n\n${body}\n`;

test("personal memory onboarding is durable, idempotent, and does not enable friend", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-personal-memory-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownerLibrary = path.join(root, "owner");
  const friend = path.join(root, "friend");
  assert.equal(ensurePersonalMemoryLibrary(ownerLibrary, "owner"), true);
  assert.equal(personalMemoryEnabled(ownerLibrary), true);
  const files = readPersonalMemoryManagedFiles(ownerLibrary);
  assert.equal(files.filter((file) => file.editable).length, 4);
  writePersonalMemoryManagedFile(ownerLibrary, "PROFILE.md", "# Owner\n\nDurable fact");
  assert.match(fs.readFileSync(path.join(ownerLibrary, "personal", "PROFILE.md"), "utf8"), /Durable fact/);
  assert.equal(ensurePersonalMemoryLibrary(friend, "friend"), false);
  assert.equal(personalMemoryEnabled(friend), false);
  ensureTenantProjectLayout({ library: ownerLibrary, root: root, codexHome: path.join(root, "home"), conversations: path.join(root, "conversations") });
  assert.equal(fs.existsSync(path.join(ownerLibrary, "personal", "ENABLED")), true);
  assert.equal(fs.existsSync(path.join(ownerLibrary, "default", "personal")), false);
});

test("project skills CRUD stays inside a tenant project and rejects symlinks", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-project-skills-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const created = createProjectSkill(project, "release-check", skill("release-check"));
  assert.equal(created.enabled, true);
  assert.equal(listProjectSkills(project)[0]?.name, "release-check");
  assert.match(readProjectSkill(project, "release-check").content, /Project-only/);
  const updated = updateProjectSkill(project, "release-check", skill("release-check", "Updated."));
  assert.match(updated.content, /Updated/);
  const disabled = setProjectSkillEnabled(project, "release-check", false);
  assert.equal(disabled.enabled, false);
  assert.equal(fs.existsSync(path.join(project, ".agents", "skills", ".disabled", "release-check", "SKILL.md")), true);
  assert.equal(setProjectSkillEnabled(project, "release-check", true).enabled, true);
  assert.throws(() => createProjectSkill(project, "../escape", skill("../escape")), /技能名称/);
  const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  fs.rmSync(path.join(project, ".agents", "skills"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(project, ".agents", "skills"), "dir");
  assert.throws(() => listProjectSkills(project), /符号链接/);
  fs.rmSync(path.join(project, ".agents"), { recursive: true, force: true });
  createProjectSkill(project, "delete-me", skill("delete-me"));
  deleteProjectSkill(project, "delete-me");
  assert.equal(fs.existsSync(path.join(project, ".agents", "skills", "delete-me")), false);
});

test("project skill API is owner-scoped and rejects host/remote semantics", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-project-skills-api-"));
  const password = "fixture";
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), username: "demo-owner", passwordHash: bcrypt.hashSync(password, 8), sessionSecret: "project-skills-test-session-secret-0123456789", queueAutoStart: false });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = instance.db.listProjects(LEGACY_USER_ID).find((candidate) => candidate.is_default === 1);
  assert.ok(project);
  const ownerAgent = request.agent(instance.app);
  const login = await ownerAgent.post("/api/auth/login").send({ username: "demo-owner", password }).expect(200);
  const created = await ownerAgent.post(`/api/projects/${project.id}/skills`).set("X-CSRF-Token", login.body.csrfToken).send({ name: "api-check", content: skill("api-check") }).expect(201);
  assert.equal(created.body.skill.name, "api-check");
  assert.equal(fs.existsSync(path.join(project.root_path, ".agents", "skills", "api-check", "SKILL.md")), true);

  const memberId = "11111111-1111-4111-8111-111111111111";
  const now = new Date().toISOString();
  instance.db.createUser({ id: memberId, username: "member", display_name: "Member", password_hash: bcrypt.hashSync(password, 8), role: "member", status: "active", created_at: now, updated_at: now });
  const memberTenant = ensureTenant(path.join(root, "tenants"), memberId);
  ensureTenantProjectLayout(memberTenant);
  const memberAgent = request.agent(instance.app);
  const memberLogin = await memberAgent.post("/api/auth/login").send({ username: "member", password }).expect(200);
  await memberAgent.get(`/api/projects/${project.id}/skills`).expect(404);
  await ownerAgent.get(`/api/projects/${project.id}/skills`).expect(200);
  await ownerAgent.delete(`/api/projects/${project.id}/skills/api-check`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.ok(memberLogin.body.csrfToken);
});
