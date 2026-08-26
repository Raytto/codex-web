import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureAccountSkillLibrary, loadAccountSkillBundle, syncAccountSkills } from "../server/account-skills.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";

function seed(root: string): void {
  const skill = path.join(root, "common", "skills", "html-report");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "common", "skills", "ENABLED"), "enabled\n");
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: html-report\ndescription: test\n---\n");
  fs.writeFileSync(path.join(skill, "scripts", "validate.py"), "print('ok')\n", { mode: 0o755 });
}

test("shared account skill seed installs the same default for every account", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-account-skills-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seeds = path.join(root, "seeds");
  seed(seeds);
  const ownerLibrary = path.join(root, "owner", "library");
  const memberLibrary = path.join(root, "member", "library");
  const demoLibrary = path.join(root, "demo", "library");
  ensureAccountSkillLibrary(ownerLibrary, HOST_ROOT_USER_ID, seeds);
  ensureAccountSkillLibrary(memberLibrary, crypto.randomUUID(), seeds);
  ensureAccountSkillLibrary(demoLibrary, crypto.randomUUID(), seeds);
  assert.equal(fs.existsSync(path.join(ownerLibrary, "skills", "ENABLED")), true);
  assert.equal(fs.existsSync(path.join(memberLibrary, "skills", "ENABLED")), true);
  assert.equal(fs.existsSync(path.join(demoLibrary, "skills", "ENABLED")), true);

  const owner = loadAccountSkillBundle(ownerLibrary);
  const member = loadAccountSkillBundle(memberLibrary);
  const demo = loadAccountSkillBundle(demoLibrary);
  assert.deepEqual(owner.skills.map((skill) => skill.name), ["html-report"]);
  assert.deepEqual(member.skills.map((skill) => skill.name), ["html-report"]);
  assert.deepEqual(demo.skills.map((skill) => skill.name), ["html-report"]);
  assert.deepEqual(member.skills, owner.skills);
  assert.deepEqual(demo.skills, owner.skills);
  assert.equal(owner.skills[0]?.files.some((file) => file.path === "SKILL.md"), true);
  assert.equal(owner.skills[0]?.files.find((file) => file.path.endsWith("validate.py"))?.executable, true);

  const ownerHome = path.join(root, "owner-home");
  const memberHome = path.join(root, "member-home");
  syncAccountSkills(ownerHome, owner);
  syncAccountSkills(memberHome, member);
  assert.equal(fs.existsSync(path.join(ownerHome, "skills", "html-report", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(memberHome, "skills", "html-report", "SKILL.md")), true);
  const demoHome = path.join(root, "demo-home");
  syncAccountSkills(demoHome, demo);
  assert.equal(fs.existsSync(path.join(demoHome, "skills", "html-report", "SKILL.md")), true);
  assert.doesNotThrow(() => syncAccountSkills(ownerHome, owner));

  fs.rmSync(path.join(ownerLibrary, "skills", "ENABLED"));
  syncAccountSkills(ownerHome, loadAccountSkillBundle(ownerLibrary));
  assert.equal(fs.existsSync(path.join(ownerHome, "skills", "html-report")), false);
});

test("account Skill synchronization never overwrites an unrelated Codex Skill", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-account-skill-conflict-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seeds = path.join(root, "seeds");
  seed(seeds);
  const library = path.join(root, "library");
  ensureAccountSkillLibrary(library, HOST_ROOT_USER_ID, seeds);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "skills", "html-report"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "html-report", "SKILL.md"), "unrelated\n");
  assert.throws(() => syncAccountSkills(home, loadAccountSkillBundle(library)), /conflicts with an existing Codex skill/);
  assert.equal(fs.readFileSync(path.join(home, "skills", "html-report", "SKILL.md"), "utf8"), "unrelated\n");
});

test("v1 account libraries receive the shared seed migration without removing custom skills", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-account-skills-migrate-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seeds = path.join(root, "seeds");
  seed(seeds);
  const library = path.join(root, "library");
  const skillsRoot = path.join(library, "skills");
  fs.mkdirSync(path.join(skillsRoot, "html-report"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "ENABLED"), "enabled\n");
  fs.writeFileSync(path.join(skillsRoot, "html-report", "SKILL.md"), "old default\n");
  fs.mkdirSync(path.join(skillsRoot, "my-custom"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "my-custom", "SKILL.md"), "custom\n");
  fs.writeFileSync(path.join(skillsRoot, ".codex-web-account-skills-seeded-v1"), "old\n");

  ensureAccountSkillLibrary(library, crypto.randomUUID(), seeds);
  assert.equal(fs.readFileSync(path.join(skillsRoot, "html-report", "SKILL.md"), "utf8"), "---\nname: html-report\ndescription: test\n---\n");
  assert.equal(fs.readFileSync(path.join(skillsRoot, "my-custom", "SKILL.md"), "utf8"), "custom\n");
  assert.equal(fs.existsSync(path.join(skillsRoot, ".codex-web-account-skills-seeded-v3")), true);
});

test("repository shared account resource contains the enabled HTML report Skill", () => {
  const root = path.join(process.cwd(), "account-resources", "common", "skills");
  assert.equal(fs.existsSync(path.join(root, "ENABLED")), true);
  const skillRoot = path.join(root, "html-report");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const styleGuide = fs.readFileSync(path.join(skillRoot, "references", "style-guide.md"), "utf8");
  const template = fs.readFileSync(path.join(skillRoot, "assets", "report-template.html"), "utf8");
  const validator = fs.readFileSync(path.join(skillRoot, "scripts", "validate_report.py"), "utf8");
  assert.match(skill, /^---\nname: html-report\n/);
  assert.match(skill, /single self-contained UTF-8 HTML file/);
  assert.match(skill, /flat, solid-color visual system/);
  assert.match(styleGuide, /Use only solid color fills/);
  assert.doesNotMatch(template, /gradient\s*\(/i);
  assert.match(validator, /CSS gradients are not allowed/);
});
