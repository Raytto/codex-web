import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountSkillBundle } from "./protocol.js";

const INSTALL_MANIFEST = ".codex-web-account-skills.json";
const OWNERSHIP_MARKER = ".codex-web-account-skill.json";
const MAX_SKILLS = 32;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function validName(value: string): boolean { return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) && !value.includes("--"); }
function normalizeFile(value: string): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) throw new Error("Invalid account skill path");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.includes("/../") || normalized.split("/").some((part) => !part || part === "." || part.length > 120)) throw new Error("Invalid account skill path");
  return normalized;
}
function revisionFor(bundle: AccountSkillBundle): string {
  const hash = crypto.createHash("sha256");
  for (const skill of bundle.skills) {
    hash.update(`${skill.name}\0`);
    for (const file of skill.files) hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0${file.contentBase64}\0`);
  }
  return hash.digest("hex");
}

export function isAccountSkillBundle(value: unknown): value is AccountSkillBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Partial<AccountSkillBundle>;
  if (bundle.version !== 1 || !/^[0-9a-f]{64}$/.test(bundle.revision ?? "") || !Array.isArray(bundle.skills) || bundle.skills.length > MAX_SKILLS) return false;
  let fileCount = 0;
  let byteCount = 0;
  const names = new Set<string>();
  for (const skill of bundle.skills) {
    if (!skill || typeof skill !== "object" || !validName(skill.name) || names.has(skill.name) || !Array.isArray(skill.files) || skill.files.length === 0) return false;
    names.add(skill.name);
    const paths = new Set<string>();
    let hasSkill = false;
    for (const file of skill.files) {
      if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.contentBase64 !== "string" || (file.executable !== undefined && file.executable !== true)) return false;
      try { normalizeFile(file.path); } catch { return false; }
      if (paths.has(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) return false;
      paths.add(file.path);
      const size = Buffer.byteLength(file.contentBase64, "base64");
      if (size > MAX_FILE_BYTES) return false;
      byteCount += size;
      fileCount += 1;
      if (file.path === "SKILL.md") hasSkill = true;
    }
    if (!hasSkill) return false;
  }
  return fileCount <= MAX_FILES && byteCount <= MAX_TOTAL_BYTES && bundle.revision === revisionFor(bundle as AccountSkillBundle);
}

function manifest(skillsRoot: string): { revision: string; skills: string[] } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(skillsRoot, INSTALL_MANIFEST), "utf8")) as { version?: unknown; revision?: unknown; skills?: unknown };
    if (value.version === 1 && typeof value.revision === "string" && Array.isArray(value.skills) && value.skills.every((name) => typeof name === "string" && validName(name))) {
      return { revision: value.revision, skills: [...new Set(value.skills as string[])] };
    }
  } catch { /* Cache metadata can be regenerated. */ }
  return { revision: "", skills: [] };
}
function owned(destination: string, name: string, revision?: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(destination, OWNERSHIP_MARKER), "utf8")) as { name?: unknown; revision?: unknown };
    return value.name === name && (revision === undefined || value.revision === revision);
  } catch { return false; }
}
function atomicWrite(destination: string, content: string): void {
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o644 });
  fs.renameSync(temporary, destination);
}

export function syncAccountSkills(codexHome: string, bundle: AccountSkillBundle): void {
  if (!isAccountSkillBundle(bundle)) throw new Error("Invalid account skill bundle");
  const skillsRoot = path.join(path.resolve(codexHome), "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const previous = manifest(skillsRoot);
  const desiredNames = bundle.skills.map((skill) => skill.name).sort();
  if (previous.revision === bundle.revision && previous.skills.slice().sort().join("\0") === desiredNames.join("\0")
    && desiredNames.every((name) => owned(path.join(skillsRoot, name), name, bundle.revision))) return;
  for (const skill of bundle.skills) {
    const destination = path.join(skillsRoot, skill.name);
    if (fs.existsSync(destination) && !owned(destination, skill.name)) throw new Error(`Account skill conflicts with an existing Codex skill: ${skill.name}`);
    const staging = path.join(skillsRoot, `.codex-web-account-${skill.name}-${crypto.randomUUID()}`);
    const backup = path.join(skillsRoot, `.codex-web-account-backup-${skill.name}-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { mode: 0o755 });
    try {
      for (const file of skill.files) {
        const target = path.join(staging, ...normalizeFile(file.path).split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
      }
      fs.writeFileSync(path.join(staging, OWNERSHIP_MARKER), `${JSON.stringify({ version: 1, name: skill.name, revision: bundle.revision })}\n`, { flag: "wx", mode: 0o644 });
      if (fs.existsSync(destination)) fs.renameSync(destination, backup);
      try { fs.renameSync(staging, destination); }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, destination); throw error; }
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  }
  const desired = new Set(desiredNames);
  for (const name of previous.skills) {
    const destination = path.join(skillsRoot, name);
    if (!desired.has(name) && owned(destination, name)) fs.rmSync(destination, { recursive: true, force: true });
  }
  atomicWrite(path.join(skillsRoot, INSTALL_MANIFEST), `${JSON.stringify({ version: 1, revision: bundle.revision, skills: desiredNames }, null, 2)}\n`);
}
