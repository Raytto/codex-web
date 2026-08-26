import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOST_ROOT_USER_ID } from "./host-root-user.js";

export const ACCOUNT_SKILL_BUNDLE_VERSION = 1 as const;
const ACCOUNT_SKILLS_DIRECTORY = "skills";
const ENABLED_MARKER = "ENABLED";
// The seed is copied into each account's library, but the source under
// account-resources/common is shared by all tenants. Bump this marker when a
// managed default needs a one-time migration into existing libraries.
const SEED_MARKER = ".codex-web-account-skills-seeded-v3";
const INSTALL_MANIFEST = ".codex-web-account-skills.json";
const OWNERSHIP_MARKER = ".codex-web-account-skill.json";
const MAX_SKILLS = 32;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export type AccountSkillFile = { path: string; contentBase64: string; executable?: true };
export type AccountSkill = { name: string; files: AccountSkillFile[] };
export type AccountSkillBundle = {
  version: typeof ACCOUNT_SKILL_BUNDLE_VERSION;
  revision: string;
  skills: AccountSkill[];
};

type InstallManifest = { version: 1; revision: string; skills: string[] };

function validSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) && !value.includes("--");
}

function normalizeFilePath(value: string): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) throw new Error("Invalid account skill file path");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Account skill file escapes its directory");
  if (normalized.split("/").some((part) => !part || part === "." || part.length > 120)) throw new Error("Invalid account skill file path component");
  return normalized;
}

function revisionFor(skills: AccountSkill[]): string {
  const hash = crypto.createHash("sha256");
  for (const skill of skills) {
    hash.update(`${skill.name}\0`);
    for (const file of skill.files) hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0${file.contentBase64}\0`);
  }
  return hash.digest("hex");
}

export function emptyAccountSkillBundle(): AccountSkillBundle {
  const skills: AccountSkill[] = [];
  return { version: ACCOUNT_SKILL_BUNDLE_VERSION, revision: revisionFor(skills), skills };
}

export function isAccountSkillBundle(value: unknown): value is AccountSkillBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Partial<AccountSkillBundle>;
  if (bundle.version !== ACCOUNT_SKILL_BUNDLE_VERSION || !/^[0-9a-f]{64}$/.test(bundle.revision ?? "") || !Array.isArray(bundle.skills) || bundle.skills.length > MAX_SKILLS) return false;
  let files = 0;
  let bytes = 0;
  const names = new Set<string>();
  for (const skill of bundle.skills) {
    if (!skill || typeof skill !== "object" || !validSkillName(skill.name) || names.has(skill.name) || !Array.isArray(skill.files) || skill.files.length === 0) return false;
    names.add(skill.name);
    const paths = new Set<string>();
    let hasSkill = false;
    for (const file of skill.files) {
      if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.contentBase64 !== "string" || (file.executable !== undefined && file.executable !== true)) return false;
      let normalized: string;
      try { normalized = normalizeFilePath(file.path); } catch { return false; }
      if (normalized !== file.path || paths.has(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) return false;
      paths.add(file.path);
      const contentBytes = Buffer.byteLength(file.contentBase64, "base64");
      if (contentBytes > MAX_FILE_BYTES) return false;
      files += 1;
      bytes += contentBytes;
      if (file.path === "SKILL.md") hasSkill = true;
    }
    if (!hasSkill) return false;
  }
  if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) return false;
  return bundle.revision === revisionFor(bundle.skills);
}

function readSkillFiles(root: string): AccountSkillFile[] {
  const files: AccountSkillFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeFilePath(path.relative(root, absolute).split(path.sep).join("/"));
      if (entry.isSymbolicLink()) throw new Error(`Account skill contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Account skill file is too large: ${relative}`);
        files.push({ path: relative, contentBase64: fs.readFileSync(absolute).toString("base64"), ...(stat.mode & 0o111 ? { executable: true as const } : {}) });
      } else throw new Error(`Unsupported account skill entry: ${relative}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function writeFileAtomically(destination: string, content: string | Buffer, mode = 0o644): void {
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode });
  fs.renameSync(temporary, destination);
}

function copySeedDirectory(source: string, destination: string, overwrite = false): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Account skill seed contains a symbolic link: ${entry.name}`);
    if (fs.existsSync(destinationPath) && !overwrite) continue;
    if (entry.isDirectory()) fs.cpSync(sourcePath, destinationPath, { recursive: true, force: overwrite, preserveTimestamps: true });
    else if (entry.isFile()) {
      if (overwrite) fs.copyFileSync(sourcePath, destinationPath);
      else fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
    else throw new Error(`Unsupported account skill seed entry: ${entry.name}`);
  }
}

export function ensureAccountSkillLibrary(libraryRoot: string, userId: string, seedRoot = path.join(process.cwd(), "account-resources")): string {
  const skillsRoot = path.join(path.resolve(libraryRoot), ACCOUNT_SKILLS_DIRECTORY);
  fs.mkdirSync(skillsRoot, { recursive: true });
  const seedMarker = path.join(skillsRoot, SEED_MARKER);
  if (!fs.existsSync(seedMarker)) {
    const commonSeed = path.join(seedRoot, "common", ACCOUNT_SKILLS_DIRECTORY);
    if (!fs.existsSync(commonSeed) || !fs.statSync(commonSeed).isDirectory()) throw new Error("Common account skill seed is unavailable");
    // Existing v1 installations receive the new shared default once. Only
    // the managed seed entries are replaced; unrelated account skills remain.
    copySeedDirectory(commonSeed, skillsRoot, true);
    if (userId === HOST_ROOT_USER_ID) {
      const accountSeed = path.join(seedRoot, "owner", ACCOUNT_SKILLS_DIRECTORY);
      if (fs.existsSync(accountSeed) && fs.statSync(accountSeed).isDirectory()) copySeedDirectory(accountSeed, skillsRoot);
    }
    writeFileAtomically(seedMarker, `${new Date().toISOString()}\n`);
  }
  return skillsRoot;
}

export function loadAccountSkillBundle(libraryRoot: string): AccountSkillBundle {
  const skillsRoot = path.join(path.resolve(libraryRoot), ACCOUNT_SKILLS_DIRECTORY);
  const enabled = path.join(skillsRoot, ENABLED_MARKER);
  if (!fs.existsSync(enabled) || !fs.lstatSync(enabled).isFile()) return emptyAccountSkillBundle();
  const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validSkillName(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ name: entry.name, files: readSkillFiles(path.join(skillsRoot, entry.name)) }))
    .filter((skill) => skill.files.some((file) => file.path === "SKILL.md"));
  const bundle = { version: ACCOUNT_SKILL_BUNDLE_VERSION, revision: revisionFor(skills), skills };
  if (!isAccountSkillBundle(bundle)) throw new Error("Account skill bundle exceeds the supported limits");
  return bundle;
}

function readManifest(skillsRoot: string): InstallManifest {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(skillsRoot, INSTALL_MANIFEST), "utf8")) as Partial<InstallManifest>;
    if (value.version === 1 && typeof value.revision === "string" && Array.isArray(value.skills) && value.skills.every((name) => typeof name === "string" && validSkillName(name))) {
      return { version: 1, revision: value.revision, skills: [...new Set(value.skills)] };
    }
  } catch { /* A missing or invalid cache manifest is treated as empty. */ }
  return { version: 1, revision: "", skills: [] };
}

function ownedSkill(destination: string, name: string, revision?: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(destination, OWNERSHIP_MARKER), "utf8")) as { name?: unknown; revision?: unknown };
    return value.name === name && (revision === undefined || value.revision === revision);
  } catch { return false; }
}

function installSkill(skillsRoot: string, skill: AccountSkill, revision: string): void {
  const destination = path.join(skillsRoot, skill.name);
  if (fs.existsSync(destination) && !ownedSkill(destination, skill.name)) throw new Error(`Account skill conflicts with an existing Codex skill: ${skill.name}`);
  const staging = path.join(skillsRoot, `.codex-web-account-${skill.name}-${crypto.randomUUID()}`);
  const backup = path.join(skillsRoot, `.codex-web-account-backup-${skill.name}-${crypto.randomUUID()}`);
  fs.mkdirSync(staging, { recursive: false, mode: 0o755 });
  try {
    for (const file of skill.files) {
      const destinationFile = path.join(staging, ...normalizeFilePath(file.path).split("/"));
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destinationFile, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    }
    fs.writeFileSync(path.join(staging, OWNERSHIP_MARKER), `${JSON.stringify({ version: 1, name: skill.name, revision })}\n`, { flag: "wx", mode: 0o644 });
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try { fs.renameSync(staging, destination); }
    catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function syncAccountSkills(codexHome: string, bundle: AccountSkillBundle): void {
  if (!isAccountSkillBundle(bundle)) throw new Error("Invalid account skill bundle");
  const skillsRoot = path.join(path.resolve(codexHome), "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const previous = readManifest(skillsRoot);
  const desired = new Set(bundle.skills.map((skill) => skill.name));
  if (previous.revision === bundle.revision && previous.skills.slice().sort().join("\0") === [...desired].sort().join("\0")
    && [...desired].every((name) => ownedSkill(path.join(skillsRoot, name), name, bundle.revision))) return;
  for (const skill of bundle.skills) installSkill(skillsRoot, skill, bundle.revision);
  for (const name of previous.skills) {
    if (desired.has(name)) continue;
    const destination = path.join(skillsRoot, name);
    if (ownedSkill(destination, name)) fs.rmSync(destination, { recursive: true, force: true });
  }
  const manifest: InstallManifest = { version: 1, revision: bundle.revision, skills: [...desired].sort() };
  writeFileAtomically(path.join(skillsRoot, INSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}
