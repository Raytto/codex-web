import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAccountSkillBundle, syncAccountSkills } from "./account-skills.js";
import type { AccountSkillBundle } from "./protocol.js";

function bundle(text = "---\nname: html-report\ndescription: test\n---\n"): AccountSkillBundle {
  const skills = [{ name: "html-report", files: [{ path: "SKILL.md", contentBase64: Buffer.from(text).toString("base64") }] }];
  const hash = crypto.createHash("sha256");
  hash.update("html-report\0");
  hash.update(`SKILL.md\0-\0${skills[0]!.files[0]!.contentBase64}\0`);
  return { version: 1, revision: hash.digest("hex"), skills };
}

test("Remote Worker validates and synchronizes an account Skill bundle", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-remote-account-skills-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = bundle();
  assert.equal(isAccountSkillBundle(first), true);
  syncAccountSkills(home, first);
  assert.match(fs.readFileSync(path.join(home, "skills", "html-report", "SKILL.md"), "utf8"), /name: html-report/);
  const second = bundle("---\nname: html-report\ndescription: updated\n---\n");
  syncAccountSkills(home, second);
  assert.match(fs.readFileSync(path.join(home, "skills", "html-report", "SKILL.md"), "utf8"), /updated/);
  syncAccountSkills(home, { version: 1, revision: crypto.createHash("sha256").digest("hex"), skills: [] });
  assert.equal(fs.existsSync(path.join(home, "skills", "html-report")), false);
});

test("Remote Worker rejects traversal and revision tampering", () => {
  const valid = bundle();
  assert.equal(isAccountSkillBundle({ ...valid, revision: "0".repeat(64) }), false);
  const escaped = structuredClone(valid);
  escaped.skills[0]!.files[0]!.path = "../SKILL.md";
  assert.equal(isAccountSkillBundle(escaped), false);
});
